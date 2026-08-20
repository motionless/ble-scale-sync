import type {
  AdapterRuntimeConfig,
  BleDeviceInfo,
  BodyComposition,
  CharacteristicBinding,
  ConnectionContext,
  GattWiring,
  HoldForComposition,
  MultiCharNotify,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import {
  buildPayload,
  computePhysiqueRating,
  r2,
  uuid16,
  type ScaleBodyComp,
} from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog } from '../ble/types.js';

// ─── Renpho R-MSC02 / MorphoScan — WELLAND FG2429WB (#230) ──────────────────

const CHR_LIVE = uuid16(0x2a10); // notify:   live weight (cmd 0x21)
const CHR_WRITE = uuid16(0x2a11); // write:    declared for interface parity, never used
const CHR_RECORD = uuid16(0x2a12); // indicate: status, final weight (0x24), records (0x25)

const HDR0 = 0x55;
const HDR1 = 0xaa;
// Header (2) + cmd (1) + length (2 BE) + checksum (1).
const FRAME_OVERHEAD = 6;

const CMD_STATUS = 0x20;
const CMD_LIVE = 0x21;
const CMD_ACK = 0x22;
const CMD_FINAL = 0x24;
const CMD_RECORD = 0x25;
// App -> scale. 0xB2 carries the user profile the scale computes composition from;
// 0xB3 sets the display unit and clock.
const CMD_APP_USER = 0xb2;
const CMD_APP_SETTING = 0xb3;
const DEFAULT_SLOT = 1;
// Byte 7 of the 0xB2 payload tracked the configured profile count as slots were
// added (0x03, 0x07, 0x0f). The earliest observed value is sent back; the scale
// accepted it and answered with an ACK.
const PROFILE_FLAGS = 0x03;
const PROFILE_TAIL = 0x02;
// 0xB3 byte 2. Verified by switching the unit in the app and re-capturing.
const WEIGHT_UNIT: Record<string, number> = { kg: 0x01, lbs: 0x02, st: 0x04 };

// Fragment tags. These prefix the raw ATT value and do NOT start with 0x55,
// which is why a listener that only looks for 55AA never sees the record.
const FRAG_FIRST = 0xad;
const FRAG_MID = 0xae;
const FRAG_LAST = 0xaf;

// 0x25 record payload offsets.
const REC_WEIGHT = 4; // uint16 BE, /100 kg
const REC_COUNT = 6; // channel count, 0x0A
const REC_IMP = 7; // ten uint16 BE, /10 ohm
const IMP_CHANNELS = 10;

// The scale's own computed composition, in the 9 bytes after the impedance
// block. Offsets and units are taken from the vendor app's own parser
// (EightElectrodeDataCommand.getFinalData, the branch every model that is not an
// MSC01/MSC05 falls through to) and cross-checked against what the app displays:
//
//   +0      user slot (1-based), matches the profile pushed in 0xB2
//   +1..2   body fat percent x10
//   +3..4   BMI x10
//   +5..6   skeletal muscle PERCENT x10
//   +7..8   visceral fat rating, a plain integer
//
// BMI is the field that validates the layout, being the only one derivable
// independently: it matches weight / height^2 on every captured record across two
// configured heights (25.8/25.7/25.4 at 180 cm, 24.3 at 185 cm).
//
// The skeletal muscle field is a RATE, not a mass, despite the vendor app storing
// it in a member called `skeletalMuscleMass`. Its own UI derives the mass the app
// displays as rate * weight / 100 (ScaleMeasureDataIndexConvertUtils, the
// SkeletalMuscleMass branch): 46.3% at 83.00 kg renders as 38.43 kg, which is
// what the app shows. Reading it as kilograms lands within a rounding error of a
// plausible body age, which is exactly why it needs stating.
//
// Metabolic age is NOT transmitted by this model. Only getFinalDataC01 (MSC01
// hardware) reads a bodyAge byte. For this scale the app computes it in native
// code (libRenphoSharedEightlib.so, via AlgorithmJni.stringFromJNIEight), along
// with body water and bone mass, so none of the three can be recovered from the
// wire.
const REC_TRAILER = REC_IMP + IMP_CHANNELS * 2; // 27
const TR_SLOT = REC_TRAILER;
const TR_FAT = REC_TRAILER + 1;
const TR_BMI = REC_TRAILER + 3;
const TR_SKELETAL_MUSCLE_PCT = REC_TRAILER + 5;
const TR_VISCERAL = REC_TRAILER + 7;
const REC_TRAILER_LEN = 9;

// Ten impedance channels: five body segments at 20 kHz, then the same five at
// 100 kHz. Order confirmed byte-for-byte against a PDF report exported from the
// Renpho app for the same weigh-in.
const SEGMENTS = ['trunk', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'] as const;

// Which frequency block feeds the single reported impedance: 0 for 20 kHz, 5 for
// 100 kHz. This only sets the `impedance` sensor value; body fat comes from the
// scale itself (see REC_TRAILER), so the choice no longer feeds any estimate.
// 20 kHz is the conventional low-frequency reference and the band the exported
// report lists first.
const BAND_OFFSET = 0;
const LEG_LEFT = BAND_OFFSET + 3;
const LEG_RIGHT = BAND_OFFSET + 4;

// The record lands ~13.5 s after the final weight (13.5, 13.6 and 13.5 s across
// three captures), so hold well past that and degrade to weight-only on timeout.
const RECORD_HOLD_MS = 20_000;

// Bone mass and body water as fractions of fat-free mass.
//
// Neither is transmitted by this model: the record trailer is fully accounted for
// (see REC_TRAILER), and in the vendor app only the MSC01/MSC05 parsers read
// bodyWater or bodyBone. Both sides therefore estimate them independently, and
// the shared defaults in buildPayload disagree with the vendor's numbers -- badly
// for bone (0.042 of lean mass reads ~1.7 kg low) and mildly for water (0.73).
// Because the vendor's own model is muscle = fat-free mass - bone, the bone
// default was also the sole reason muscle mass read ~1.7 kg high.
//
// Fitted against two exported reports for records decoded from capture, which
// agreed on fat-free mass to the cent (it follows from the transmitted body fat,
// so it is not fitted at all):
//
//   180 cm, 82.40 kg, FFM 63.45   bone 4.20  water 46.47   -> 0.06620 / 0.73241
//   185 cm, 83.00 kg, FFM 67.06   bone 4.50  water 49.22   -> 0.06710 / 0.73393
//                                                   midpoint -> 0.06665 / 0.73317
//
// The second report was a genuine out-of-sample test of the first fit and
// confirmed the SHAPE: as fat-free mass fell 5.4%, bone fell 6.7% rather than
// holding flat, so proportionality to fat-free mass is right. The ~1.3% spread
// between the two ratios means there is some weak additional dependence (height
// is the obvious candidate, since the two reports differ in it), too small to
// model from two points.
//
// The midpoint of the two observations is used. Picking either endpoint instead
// moves this subject's bone mass by 0.06 kg, so the choice is immaterial; the
// midpoint just avoids implying the adapter is tuned to one height.
//
// SCOPE, for reviewers: both reports come from ONE subject, so these ratios are
// not established as person-invariant, and a native vendor algorithm that takes
// height, age and sex almost certainly does not treat them as constant. What is
// established is that 0.042 is wrong for this hardware by 37% (1.54 kg on this
// subject) in a direction that also drags muscle mass with it. Even reading the
// 1.37% spread between the two ratios as a pure height gradient -- the least
// favourable interpretation -- extrapolating to 160-200 cm costs at most 0.25 kg,
// six times smaller than the error being removed. So this is a strict improvement
// for every user of this scale while remaining provisional in its exact value; a
// report from a second subject is what would settle it.
const BONE_FRACTION_OF_FFM = 0.0666;
const WATER_FRACTION_OF_FFM = 0.7332;

// The scale changes what it reports below this age, and the vendor app prints
// "--" for bone mass there, so BONE_FRACTION_OF_FFM has no ground truth to be
// checked against for a child and is not extrapolated across it.
// WATER_FRACTION_OF_FFM is unaffected -- it is confirmed on a child report.
const ADULT_AGE = 18;

// Basal metabolic rate from measured lean mass (Katch-McArdle, 370 + 21.6 x FFM).
// buildPayload uses Mifflin-St Jeor, which proxies lean mass from weight, height,
// age and sex because most scales cannot measure it -- this one can, and the
// vendor evidently uses the same substitution: across three exported reports the
// implied coefficients are 21.577, 21.606 and 21.587 against the published 21.6,
// reproducing the reported BMR to within 1.5 kcal (1739, 1819 and 986). The child
// report is where the difference shows: Mifflin-St Jeor returns 1219 there,
// because for a small body its height term dominates and it cannot see how little
// lean mass is present.
const BMR_BASE = 370;
const BMR_PER_KG_FFM = 21.6;

// buildPayload's own lower bound for metabolic age, reused so this adapter cannot
// publish a figure the shared helper would consider out of range.
const METABOLIC_AGE_FLOOR = 12;

// Fragment-reassembly bounds. A record is 42 bytes over three fragments; these
// only exist so malformed traffic cannot grow the buffer without limit.
const MAX_PENDING_FRAGMENTS = 4;
const MAX_RECORD_BYTES = 256;

/**
 * Adapter for the Renpho R-MSC02 / MorphoScan 8-electrode scale, a rebadged
 * WELLAND FG2429WB (#230).
 *
 * Reverse-engineered from Android btsnoop captures of the Renpho Health app and
 * validated against PDF reports exported from the same weigh-ins.
 *
 * GATT — vendor service 0x1A10, same as ES-CS20M and the R-MSC04:
 *   0x2A10  notify    live weight, cmd 0x21
 *   0x2A11  write     app -> scale (this adapter never writes; see below)
 *   0x2A12  indicate  status, final weight (0x24) and the fragmented records
 *
 * Framing is `55 AA | cmd(1) | len(2 BE) | payload(len) | checksum(1)` with
 * checksum = the low byte of the sum of every preceding byte. Weight for the
 * 0x21/0x24 commands is the last two payload bytes, big-endian, / 100.
 *
 * Long records are fragmented UNDERNEATH that framing with a 3-byte
 * `tag/seq/remaining` prefix (AD first, AE middle, AF last). Fragments do not
 * begin with 0x55, so the frame decoder must run on the reassembled buffer, not
 * on each ATT value. This is the reason #230 sees a connection but no data even
 * once the frames are no longer discarded.
 *
 * THE HANDSHAKE. On a fresh subscription the scale sends a 0x20 STATUS frame and
 * then waits. Until it is told who is standing on it, it never emits a record:
 * the record's trailer is body fat, BMI, skeletal muscle and visceral rating, all
 * of which need height, age and sex. A silent client gets live weight, a settled
 * 0x24, and then the wind-down states, with no record and no impedance.
 *
 * The exchange, captured from the vendor app and reproduced end to end from a
 * standalone client:
 *
 *   scale 0x20 STATUS  ->  app 0xB2 APP_USER    (slot, height, weight, age, sex)
 *   scale 0x22 ACK     ->  app 0xB3 APP_SETTING (display unit + clock)
 *   scale 0x23 INFO    ->  measurement proceeds; 0x25 record follows the weight
 *
 * There is NO unlock command on this model. Writing the ES-CS20M unlock that the
 * R-MSC04 needs (0x90 to 0x2A11) is what makes an R-MSC02 hang up, which is the
 * behaviour reported in #230.
 *
 * 0xB2 WRITES A PROFILE SLOT on the scale: its height, age and sex, exactly as the
 * app does on every connection. A wrong profile therefore produces wrong
 * composition AND overwrites that slot, so the values are logged at info on every
 * connection and range-checked before being sent. The slot comes from
 * `scaleAuth.userIndex` (Beurer's precedent for a device-side user index) and
 * defaults to 1.
 *
 * The push is driven from `buildAck` rather than `onConnected` because the scale
 * expects it in response to STATUS. That also leaves room for the sync layer to
 * identify the user from the live weight first: the scale does not compute until
 * ~15 s after the settled weight, and a profile pushed after the first live frame
 * still yields a correct record.
 *
 * Athlete mode is deliberately absent here: the scale is never told about it
 * (verified by an isolated on/off test that produced byte-identical writes), so
 * `UserProfile.isAthlete` is applied locally by `buildPayload`/`computeBiaFat`
 * like every other adapter.
 *
 * NOT IMPLEMENTED: the 0x26 history record. It carries a 4-byte age field that
 * shifts the layout, and in the one capture that contains it the impedance block
 * duplicated the live 0x25 record while the weight differed — stale enough that
 * replaying it as cached history would risk publishing a wrong reading.
 *
 * Routing is by advertised name only. The device also exposes 0x1A10, which
 * ES-CS20M claims, so this adapter does NOT claim the service: a nameless
 * 0x1A10 device stays with ES-CS20M while a named R-MSC02 wins on priority.
 */
export class RenphoMsc02Adapter
  implements ScaleAdapterCore, GattWiring, MultiCharNotify, HoldForComposition
{
  readonly name = 'Renpho R-MSC02';
  readonly match: MatchDescriptor = {
    // 236 rather than the R-MSC04's 235 only because the registry requires
    // unique priorities; the two name matches are disjoint so order is moot.
    priority: 236,
    custom: true,
    names: { exact: ['r-msc02'] },
  };
  // Legacy single-char fallback (unused in multi-char mode).
  readonly charNotifyUuid = CHR_LIVE;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;

  // 0x2A12 is physically an indicate characteristic. The shared subscribe loop
  // only auto-subscribes 'notify' bindings and node-ble/noble enable indications
  // transparently, so declare it 'notify' (same pattern as RenphoMsc04).
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_LIVE, type: 'notify' },
    { uuid: CHR_RECORD, type: 'notify' },
    { uuid: CHR_WRITE, type: 'write' },
  ];

  readonly completionHoldMs = RECORD_HOLD_MS;

  private finished = false;
  private profile: UserProfile | null = null;
  private slot = DEFAULT_SLOT;
  private seq = 1;
  private lastLiveWeight = 0;
  private weightUnit: string | undefined;
  private profileSent = false;
  private settingSent = false;
  private scaleComp: {
    weight: number;
    comp: ScaleBodyComp;
    /** null when the scale did not measure it (it zeroes this under 18). */
    skeletalMusclePercent: number | null;
  } | null = null;
  private fragments = new Map<number, Buffer>();

  configure(opts: AdapterRuntimeConfig): void {
    this.weightUnit = opts.weightUnit;
  }

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  /** No handshake; resets state because the instance is a shared singleton. */
  onConnected(ctx: ConnectionContext): void {
    this.resetSession();
    // buildAck runs without a context, so the profile has to be captured here.
    this.profile = ctx.profile;
    this.slot = ctx.scaleAuth?.userIndex ?? DEFAULT_SLOT;
    bleLog.info(
      `Renpho R-MSC02: profile for slot ${this.slot} — ${ctx.profile.height} cm, ` +
        `age ${ctx.profile.age}, ${ctx.profile.gender}. The scale stores this and ` +
        'computes body composition from it.',
    );
  }

  parseCharNotification(_charUuid: string, data: Buffer): ScaleReading | null {
    const buf = this.reassemble(data);
    if (!buf) return null;

    const frame = this.decodeFrame(buf);
    if (!frame) return null;

    if (frame.cmd === CMD_LIVE || frame.cmd === CMD_FINAL) {
      // Live weight is only meaningful before the measurement settles. Once it has,
      // ignoring these matters twice over, because `finished` never un-latches:
      //
      //  - The handler holds the link open for the record, and HoldTimer.hold()
      //    replaces the held reading on every call. A user stepping off produces
      //    live frames that pass the 0.5 kg floor, so the reading that resolves on
      //    timeout would be the step-off weight, not the settled one.
      //  - The adapter instance is a shared singleton and the handler subscribes to
      //    notify characteristics BEFORE calling onConnected (see subscribeAndInit),
      //    so the first frames of a new session arrive while `finished` is still
      //    true from the previous one and would otherwise resolve immediately.
      if (this.finished) return null;

      const weight = this.weightOf(frame.payload);
      if (weight === null) return null;
      this.lastLiveWeight = weight;
      // The final frame ends the measurement; the record may still follow.
      if (frame.cmd === CMD_FINAL) this.finished = true;
      return { weight, impedance: 0 };
    }

    if (frame.cmd === CMD_RECORD) {
      // A new record supersedes any earlier one even if it fails to decode, so a
      // rejected record can never leave a previous composition to be grafted on.
      this.scaleComp = null;
      const rec = this.decodeRecord(frame.payload);
      if (!rec) return null;
      // A record is terminal evidence the measurement finished, so latch even if
      // the 0x24 frame was missed — otherwise the richest reading never resolves.
      this.finished = true;
      return { weight: rec.weight, impedance: rec.impedance };
    }

    return null; // status/ack/history — not this adapter's business
  }

  /** Legacy single-char path (frames self-identify; the char UUID is irrelevant). */
  parseNotification(data: Buffer): ScaleReading | null {
    return this.parseCharNotification(CHR_LIVE, data);
  }

  /**
   * Strip the AD/AE/AF fragment layer. Returns the buffer to decode, or null
   * while a record is still incomplete. Unfragmented values pass straight
   * through.
   */
  private reassemble(data: Buffer): Buffer | null {
    if (data.length === 0) return null;
    const tag = data[0];
    if (tag !== FRAG_FIRST && tag !== FRAG_MID && tag !== FRAG_LAST) return data;
    if (data.length < 3) return null;

    const seq = data[1];
    const remaining = data[2];
    const body = data.subarray(3);

    if (tag === FRAG_FIRST) {
      // A stale partial from an aborted record must not wedge the map.
      if (this.fragments.size >= MAX_PENDING_FRAGMENTS) this.fragments.clear();
      this.fragments.set(seq, Buffer.from(body));
    } else {
      const prev = this.fragments.get(seq);
      if (!prev) return null; // middle/last with no first — nothing to append to
      if (prev.length + body.length > MAX_RECORD_BYTES) {
        this.fragments.delete(seq);
        return null;
      }
      this.fragments.set(seq, Buffer.concat([prev, body]));
    }

    if (tag !== FRAG_LAST && remaining !== 0) return null;
    const done = this.fragments.get(seq) ?? null;
    this.fragments.delete(seq);
    return done;
  }

  /** Validate a 55AA frame and return its command + payload, or null. */
  private decodeFrame(buf: Buffer): { cmd: number; payload: Buffer } | null {
    if (buf.length < FRAME_OVERHEAD) return null;
    if (buf[0] !== HDR0 || buf[1] !== HDR1) return null;

    const frameLen = buf.readUInt16BE(3) + FRAME_OVERHEAD;
    if (buf.length < frameLen) return null; // truncated / declared-length mismatch

    let sum = 0;
    for (let i = 0; i < frameLen - 1; i++) sum += buf[i];
    if ((sum & 0xff) !== buf[frameLen - 1]) return null;

    return { cmd: buf[2], payload: buf.subarray(5, frameLen - 1) };
  }

  /** 0x21/0x24: weight is the last two payload bytes, big-endian, / 100. */
  private weightOf(payload: Buffer): number | null {
    if (payload.length < 2) return null;
    const weight = payload.readUInt16BE(payload.length - 2) / 100;
    return weight >= 0.5 && weight <= 300 ? weight : null;
  }

  /**
   * 0x25: settled weight plus ten impedance channels.
   *
   * `impedance` is reduced to the leg-to-leg path (see BAND_OFFSET) because
   * `BodyComposition.impedance` is a single number; the other eight channels have
   * nowhere to go and are logged at debug so a segmental reading can be checked
   * against the Renpho app's own report.
   *
   * The trailer after the impedance block carries the scale's OWN computed body
   * fat, BMI, skeletal muscle rate and visceral rating, which is what this adapter
   * publishes. No BIA estimate is derived from the impedance: the shared
   * coefficients expect a different impedance path and read roughly 34% body fat
   * where the scale itself reports 23%, so estimating would be both wrong and
   * inconsistent with the app's own history. Metabolic age, body water and bone
   * mass are not on the wire for this model at all (see REC_TRAILER).
   */
  private decodeRecord(payload: Buffer): { weight: number; impedance: number } | null {
    if (payload.length < REC_TRAILER + REC_TRAILER_LEN) return null;
    // Refuse to guess if the firmware ever reports a different channel count.
    if (payload[REC_COUNT] !== IMP_CHANNELS) return null;

    const weight = payload.readUInt16BE(REC_WEIGHT) / 100;
    if (!(weight >= 0.5 && weight <= 300)) return null;

    const ohms: number[] = [];
    for (let i = 0; i < IMP_CHANNELS; i++) ohms.push(payload.readUInt16BE(REC_IMP + i * 2) / 10);

    const impedance = r2(ohms[LEG_LEFT] + ohms[LEG_RIGHT]);
    if (!(impedance > 50 && impedance < 1500)) return null;

    bleLog.debug(
      `Renpho R-MSC02 segmental impedance (Ohm): ` +
        SEGMENTS.map((s, i) => `${s}=${ohms[i]}`).join(' ') +
        ' @20kHz | ' +
        SEGMENTS.map((s, i) => `${s}=${ohms[i + SEGMENTS.length]}`).join(' ') +
        ' @100kHz',
    );
    // Trunk impedance is an order of magnitude below the limbs and 100 kHz sits
    // below 20 kHz in every segment. Poor foot/hand contact (socks, dry skin)
    // breaks this, and the resulting composition is not trustworthy.
    const suspect =
      SEGMENTS.some((_, i) => ohms[i + SEGMENTS.length] >= ohms[i]) ||
      ohms[0] >= Math.min(ohms[1], ohms[2], ohms[3], ohms[4]) / 3;
    if (suspect) {
      bleLog.warn(
        'Renpho R-MSC02: implausible segmental impedance — check bare feet and ' +
          'dry-skin contact; body composition from this reading may be wrong',
      );
    }

    // The scale computes body fat, BMI, skeletal muscle rate and a visceral
    // rating itself. Prefer them over anything derived here: they are what the
    // Renpho app shows, so trends stay comparable with the app's own history.
    const fat = payload.readUInt16BE(TR_FAT) / 10;
    const bmi = payload.readUInt16BE(TR_BMI) / 10;
    const skeletalMusclePercent = payload.readUInt16BE(TR_SKELETAL_MUSCLE_PCT) / 10;
    const visceralFat = payload.readUInt16BE(TR_VISCERAL);
    bleLog.debug(
      `Renpho R-MSC02 scale-computed: slot=${payload[TR_SLOT]} fat=${fat}% ` +
        `bmi=${bmi} ` +
        `skeletalMuscle=${skeletalMusclePercent}% ` +
        `(${r2((skeletalMusclePercent * weight) / 100)} kg) visceralFat=${visceralFat}`,
    );

    // Each trailer field is independently optional, because the scale does not
    // populate all of them for every profile: for a user under 18 it sends body
    // fat and BMI but zeroes skeletal muscle and the visceral rating (captured
    // from a 10-year-old at 150 cm: fat 12.6%, BMI 14.5, both others 0). Gating
    // the whole trailer on every field being in range threw away a valid body fat
    // and fell back to a BMI estimate that clamped to 3.5% for that child.
    //
    // Zero means "not measured", not a real value: Renpho's visceral scale starts
    // at 1, and buildPayload would turn a passed-through 0 into 1.
    //
    // These are range checks, not consistency checks: the transmitted BMI is
    // computed from the height the SCALE was last told, which need not equal the
    // configured profile height, so comparing the two would reject good records.
    const comp: ScaleBodyComp = {};
    if (fat >= 3 && fat <= 60) comp.fat = fat;
    if (visceralFat >= 1 && visceralFat <= 59) comp.visceralFat = visceralFat;
    const skeletal =
      skeletalMusclePercent >= 10 && skeletalMusclePercent <= 70 ? skeletalMusclePercent : null;

    // Body fat is the one field everything else keys off, so without it the
    // trailer is unusable and estimation is the honest fallback.
    this.scaleComp = comp.fat != null ? { weight, comp, skeletalMusclePercent: skeletal } : null;
    if (comp.fat == null) {
      bleLog.warn(
        'Renpho R-MSC02: no usable body fat in the record trailer, estimating ' +
          'from BMI instead',
      );
    } else if (skeletal == null || comp.visceralFat == null) {
      bleLog.debug(
        'Renpho R-MSC02: partial trailer (the scale omits skeletal muscle and ' +
          'visceral fat for profiles under 18); those two will be derived',
      );
    }

    return { weight, impedance };
  }

  /** 55AA | cmd | len(2 BE) | payload | checksum (sum of the preceding bytes). */
  private buildFrame(cmd: number, payload: number[]): number[] {
    const head = [HDR0, HDR1, cmd, (payload.length >> 8) & 0xff, payload.length & 0xff];
    const body = [...head, ...payload];
    return [...body, body.reduce((a, b) => a + b, 0) & 0xff];
  }

  /** 0xB2: the profile the scale computes body composition from. */
  private buildProfileWrite(p: UserProfile): number[] | null {
    if (!(p.height >= 50 && p.height <= 250) || !(p.age >= 5 && p.age <= 120)) {
      bleLog.warn(
        `Renpho R-MSC02: refusing to push an implausible profile ` +
          `(${p.height} cm, age ${p.age}); the scale would store it and compute from it`,
      );
      return null;
    }
    const h = Math.round(p.height * 10); // tenths of a cm
    const w = Math.round(this.lastLiveWeight * 100);
    const sexAge = (p.gender === 'male' ? 0x80 : 0x00) | (p.age & 0x7f);
    return this.buildFrame(CMD_APP_USER, [
      this.seq++,
      this.slot,
      (h >> 8) & 0xff,
      h & 0xff,
      (w >> 8) & 0xff,
      w & 0xff,
      sexAge,
      PROFILE_FLAGS,
      PROFILE_TAIL,
    ]);
  }

  /** 0xB3: display unit and clock. Sending the configured unit stops the scale
   * being flipped to a unit the user did not choose (#269). */
  private buildSettingWrite(): number[] {
    const t = Math.floor(Date.now() / 1000);
    return this.buildFrame(CMD_APP_SETTING, [
      this.seq++,
      0x07,
      WEIGHT_UNIT[this.weightUnit ?? 'kg'],
      0x01,
      (t >>> 24) & 0xff,
      (t >>> 16) & 0xff,
      (t >>> 8) & 0xff,
      t & 0xff,
      0x00,
      0x78,
      0x00,
    ]);
  }

  /**
   * Answer the scale's STATUS with a profile, and its ACK with the settings, which
   * is what unblocks the record. Fragments are ignored here: they never carry
   * STATUS or ACK, and consuming them would race the reassembler in
   * parseCharNotification, which sees the same bytes.
   */
  buildAck(data: Buffer): number[] | null {
    if (!this.profile) return null; // no session yet
    if (data.length < FRAME_OVERHEAD || data[0] !== HDR0 || data[1] !== HDR1) return null;
    const frame = this.decodeFrame(data);
    if (!frame) return null;

    if (frame.cmd === CMD_STATUS && !this.profileSent) {
      const write = this.buildProfileWrite(this.profile);
      this.profileSent = true; // do not retry a refused profile every STATUS
      if (write) bleLog.debug(`Renpho R-MSC02: pushing profile to slot ${this.slot}`);
      return write;
    }
    if (frame.cmd === CMD_ACK && this.profileSent && !this.settingSent) {
      this.settingSent = true;
      return this.buildSettingWrite();
    }
    return null;
  }

  /**
   * Clear everything captured from the connection. Without this the next session
   * inherits the previous one's profile, latches and partial fragments, and the
   * handler subscribes before it calls onConnected, so those frames arrive first.
   */
  onSessionEnd(): void {
    this.resetSession();
  }

  private resetSession(): void {
    this.profile = null;
    this.slot = DEFAULT_SLOT;
    this.seq = 1;
    this.lastLiveWeight = 0;
    this.profileSent = false;
    this.settingSent = false;
    this.finished = false;
    this.scaleComp = null;
    this.fragments.clear();
  }

  /** Weight alone resolves; the hold window is what waits for the record. */
  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.finished;
  }

  /** Resolve immediately once the impedance record has landed. */
  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // Use the scale's own composition only for the reading it came with. The
    // adapter is a shared singleton, so weight equality alone is not identity: two
    // household members can weigh the same to the cent, and a live frame can match
    // a cached record's weight exactly. Only a record produces impedance > 0, so
    // require that too.
    const own =
      reading.impedance > 0 && this.scaleComp?.weight === reading.weight ? this.scaleComp : null;

    // Without a record, buildPayload estimates body fat from BMI and the profile.
    const payload = buildPayload(reading.weight, reading.impedance, own?.comp ?? {}, profile);

    if (own) {
      if (own.skeletalMusclePercent !== null) {
        // computePhysiqueRating wants SKELETAL muscle mass, which buildPayload can
        // only approximate as 0.54 * lean mass. Here it is measured, so recompute.
        // `muscleMass` is deliberately left as buildPayload's fat-free-mass-minus-bone:
        // that is what Garmin and the vendor apps mean by the term (#253), and it is a
        // different quantity from skeletal muscle rather than a better estimate of it.
        const skeletalMuscleKg = (own.skeletalMusclePercent * reading.weight) / 100;
        payload.physiqueRating = computePhysiqueRating(
          payload.bodyFatPercent,
          skeletalMuscleKg,
          reading.weight,
        );
      }

      // Fat-free mass follows exactly from the transmitted body fat, so both of
      // these need only their one calibrated ratio.
      const ffm = reading.weight * (1 - payload.bodyFatPercent / 100);

      // Hydration holds across every report obtained so far: 0.73241 and 0.73393
      // for an adult at two heights, and 0.73346 for a 10-year-old at 32.65 kg --
      // 0.21% spread over a 2.3x range of fat-free mass and 35 years of age. So it
      // is applied at every age. It is also athlete-independent, unlike
      // buildPayload's 0.73/0.74 split, necessarily so since the scale is never
      // told about athlete mode. Athlete mode still moves BMR and physique rating.
      payload.waterPercent = r2(((ffm * WATER_FRACTION_OF_FFM) / reading.weight) * 100);

      // Bone is different: the vendor app reports it as "--" for an under-18
      // profile, so no child ground truth exists to check the adult ratio against,
      // and extrapolating a two-point adult fit onto a child is not justified.
      // Under 18 keeps buildPayload's shared default, and muscle mass with it,
      // since the vendor's own model is muscle = fat-free mass - bone.
      if (profile.age >= ADULT_AGE) {
        payload.boneMass = r2(ffm * BONE_FRACTION_OF_FFM);
        payload.muscleMass = r2(ffm - payload.boneMass);
      }

      // Lean mass is measured here rather than inferred, so use the formula that
      // takes it (see BMR_BASE). Not age-gated: it reproduces the child report
      // exactly, which is the case Mifflin-St Jeor gets most wrong.
      payload.bmr = Math.trunc(BMR_BASE + BMR_PER_KG_FFM * ffm);
    }

    // This model never transmits a metabolic age, and buildPayload's derivation
    // cannot supply one: its weight, height and sex terms cancel, leaving
    // `age + trunc((age - 25) / 3)`, which is a function of the birthday alone.
    // 60 kg at 8% fat and 110 kg at 40% fat both return 51 at age 45, and the
    // female branch adds a further ~11 years for the same body because the sex
    // constant does not cancel. Publishing the chronological age asserts no
    // deviation instead of an invented penalty. A composition-aware replacement
    // needs normative fat-free mass by age and sex, which the vendor has and this
    // project does not; deriving one from the BMR above swings 3.6 years per
    // percentage point of body fat, which is noisier than the trend it reports.
    payload.metabolicAge = Math.max(METABOLIC_AGE_FLOOR, profile.age);
    return payload;
  }
}
