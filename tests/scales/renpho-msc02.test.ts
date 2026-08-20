import { describe, it, expect, vi } from 'vitest';
import { RenphoMsc02Adapter } from '../../src/scales/renpho-msc02.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { buildPayload, computePhysiqueRating, uuid16 } from '../../src/scales/body-comp-helpers.js';
import { bleLog } from '../../src/ble/types.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

// Every buffer below is verbatim from Android btsnoop captures of the Renpho
// Health app talking to a real R-MSC02.

const LIVE = Buffer.from('55aa2100050100002062a8', 'hex'); // cmd 0x21 -> 82.90
const FINAL = Buffer.from('55aa24000601110000206cc7', 'hex'); // cmd 0x24 -> 83.00

// The 0x25 impedance record, fragmented AD/AE/AF. This one is the calibration
// anchor: all ten channels match a PDF report exported from the Renpho app for
// the same 82.40 kg weigh-in.
//   20 kHz  trunk 27.7  Larm 300.3  Rarm 293.9  Lleg 273.6  Rleg 274.5
//   100 kHz trunk 24.6  Larm 268.1  Rarm 261.6  Lleg 240.9  Rleg 242.2
const REPORT_RECORD = [
  'ad040255aa2500240411000020300a01150bbb0b',
  'ae04017b0ab00ab900f60a790a38096909760100',
  'af0400e600fe01b60007e5',
].map((h) => Buffer.from(h, 'hex'));
const REPORT_WEIGHT = 82.4;
const REPORT_LEG_TO_LEG = 548.1; // 273.6 + 274.5 @ 20 kHz

// A second, independent record from a later session (83.00 kg).
const RECORD_2 = [
  'ad040255aa25002404110000206c0a010c0bdc0b',
  'ae0401870a7e0a8c00ee0a9f0a55094609580100',
  'af0400c000f301cf0005c6',
].map((h) => Buffer.from(h, 'hex'));

// A profile under 18: the scale sends body fat and BMI but zeroes skeletal muscle
// and the visceral rating. Captured from a 10-year-old at 150 cm / 32.65 kg --
// fat 12.6%, BMI 14.5, skeletal 0, visceral 0, all ten impedances present.
const KID_RECORD = [
  'ad040255aa250024041100000cc10a015c131812',
  'ae0401fc0fc20f8b01401186117c0e610e1f0400',
  'af04007e00910000000049',
].map((h) => Buffer.from(h, 'hex'));
const KID_PROFILE = { height: 150, age: 10, gender: 'male' as const, isAthlete: false };

// The same child's first attempt: weight and BMI only, every impedance and the
// whole composition zeroed. A measurement that did not take.
const EMPTY_RECORD = [
  'ad030255aa250024031100000cc10a0000000000',
  'ae03010000000000000000000000000000000400',
  'af030000009100000000c8',
].map((h) => Buffer.from(h, 'hex'));

const LIVE_CHR = uuid16(0x2a10);
const REC_CHR = uuid16(0x2a12);

function makeAdapter() {
  return new RenphoMsc02Adapter();
}

/** Feed fragments in order; return the reading produced by the last one. */
function feed(adapter: RenphoMsc02Adapter, frags: Buffer[]) {
  let last = null as ReturnType<RenphoMsc02Adapter['parseCharNotification']>;
  for (const f of frags) last = adapter.parseCharNotification(REC_CHR, f);
  return last;
}

function mockCtx(availableChars: string[] = []): ConnectionContext {
  return {
    profile: defaultProfile(),
    deviceAddress: 'AA',
    availableChars: new Set(availableChars),
    write: vi.fn(),
    read: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as ConnectionContext;
}

describe('RenphoMsc02Adapter', () => {
  describe('matches() and registry resolution (#230)', () => {
    it('matches the exact "R-MSC02" name, case-insensitively', () => {
      expect(makeAdapter().matches(mockPeripheral('R-MSC02'))).toBe(true);
      expect(makeAdapter().matches(mockPeripheral('r-msc02'))).toBe(true);
    });

    it('does not match the R-MSC04, ES-CS20M, or unrelated names', () => {
      expect(makeAdapter().matches(mockPeripheral('r-msc04'))).toBe(false);
      expect(makeAdapter().matches(mockPeripheral('es-cs20m'))).toBe(false);
      expect(makeAdapter().matches(mockPeripheral('Random Scale'))).toBe(false);
    });

    it('resolves a named R-MSC02 here rather than ES-CS20M, which also claims 0x1A10', () => {
      const info = mockPeripheral('R-MSC02', [uuid16(0x1a10)]);
      expect(resolveAdapter(info)?.name).toBe('Renpho R-MSC02');
      expect(adapters.filter((a) => a.matches(info))[0]?.name).toBe('Renpho R-MSC02');
    });

    it('leaves a nameless 0x1A10 device to ES-CS20M', () => {
      const info = mockPeripheral('', [uuid16(0x1a10)]);
      expect(makeAdapter().matches(info)).toBe(false);
      expect(resolveAdapter(info)?.name).toBe('ES-CS20M');
    });
  });

  describe('handshake', () => {
    const STATUS = Buffer.from('55aa200005000101000026', 'hex');
    const ACK = Buffer.from('55aa22000201012 5'.replace(/ /g, ''), 'hex');

    function connected(over?: Partial<ReturnType<typeof defaultProfile>>) {
      const a = makeAdapter();
      a.onConnected({
        ...mockCtx(),
        profile: defaultProfile({ height: 180, age: 45, gender: 'male', ...over }),
      } as never);
      return a;
    }

    it('answers STATUS with a 0xB2 profile carrying height, age and sex', () => {
      const a = connected();
      const out = a.buildAck(STATUS);
      expect(out).not.toBeNull();
      const b = Buffer.from(out!);
      expect(b.subarray(0, 3)).toEqual(Buffer.from('55aab2', 'hex'));
      expect(b.readUInt16BE(3)).toBe(9); // payload length
      expect(b[6]).toBe(1); // slot, default
      expect(b.readUInt16BE(7)).toBe(1800); // 180.0 cm in tenths
      expect(b[11]).toBe(0x80 | 45); // male | age
      // checksum = sum of every preceding byte
      const sum = [...b.subarray(0, b.length - 1)].reduce((x, y) => x + y, 0) & 0xff;
      expect(b[b.length - 1]).toBe(sum);
    });

    it('answers the ACK with 0xB3, and only after the profile went out', () => {
      const a = connected();
      expect(a.buildAck(ACK)).toBeNull(); // nothing sent yet
      a.buildAck(STATUS);
      const b = Buffer.from(a.buildAck(ACK)!);
      expect(b.subarray(0, 3)).toEqual(Buffer.from('55aab3', 'hex'));
      expect(b[7]).toBe(0x01); // kg
    });

    it('sends each write once per session', () => {
      const a = connected();
      expect(a.buildAck(STATUS)).not.toBeNull();
      expect(a.buildAck(STATUS)).toBeNull();
      a.buildAck(ACK);
      expect(a.buildAck(ACK)).toBeNull();
    });

    it('carries the configured display unit so the scale is not flipped (#269)', () => {
      const a = connected();
      a.configure({ weightUnit: 'lbs' });
      a.buildAck(STATUS);
      expect(Buffer.from(a.buildAck(ACK)!)[7]).toBe(0x02);
    });

    it('refuses to push an implausible profile rather than storing it on the scale', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      expect(connected({ height: 5, age: 45 }).buildAck(STATUS)).toBeNull();
      expect(connected({ height: 180, age: 200 }).buildAck(STATUS)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('writes nothing before onConnected has supplied a profile', () => {
      expect(makeAdapter().buildAck(STATUS)).toBeNull();
    });

    it('ignores fragments, which never carry STATUS or ACK', () => {
      // Consuming these here would race the reassembler, which sees the same bytes.
      expect(connected().buildAck(REPORT_RECORD[0])).toBeNull();
      expect(connected().buildAck(REPORT_RECORD[1])).toBeNull();
    });

    it('clears the captured profile and latches on session end (#138)', () => {
      const a = connected();
      a.buildAck(STATUS);
      feed(a, REPORT_RECORD);
      a.onSessionEnd();
      // No profile: nothing may be written, and no stale record may be grafted on.
      expect(a.buildAck(STATUS)).toBeNull();
      expect(a.isComplete({ weight: 82.4, impedance: 548.1 })).toBe(false);
      const after = a.computeMetrics(
        { weight: REPORT_WEIGHT, impedance: REPORT_LEG_TO_LEG },
        defaultProfile({ height: 180, age: 45 }),
      );
      expect(after.visceralFat).not.toBe(7);
    });
  });

  describe('weight frames', () => {
    it('parses a cmd 0x21 live frame -> 82.90 kg without completing', () => {
      const adapter = makeAdapter();
      const r = adapter.parseCharNotification(LIVE_CHR, LIVE);
      expect(r).not.toBeNull();
      expect(r!.weight).toBeCloseTo(82.9, 2);
      expect(r!.impedance).toBe(0);
      expect(adapter.isComplete(r!)).toBe(false);
    });

    it('parses a cmd 0x24 final frame -> 83.00 kg and completes, but is not final', () => {
      const adapter = makeAdapter();
      const r = adapter.parseCharNotification(REC_CHR, FINAL);
      expect(r!.weight).toBeCloseTo(83.0, 2);
      expect(adapter.isComplete(r!)).toBe(true);
      // Not final: the handler must hold the link open for the record.
      expect(adapter.isFinal(r!)).toBe(false);
    });

    it('rejects a bad checksum, a bad header, and a truncated frame', () => {
      const adapter = makeAdapter();
      expect(
        adapter.parseCharNotification(REC_CHR, Buffer.from('55aa24000601110000206cc8', 'hex')),
      ).toBeNull();
      expect(
        adapter.parseCharNotification(REC_CHR, Buffer.from('56aa24000601110000206cc7', 'hex')),
      ).toBeNull();
      expect(adapter.parseCharNotification(REC_CHR, Buffer.from('55aa240006', 'hex'))).toBeNull();
      expect(adapter.isComplete({ weight: 83, impedance: 0 })).toBe(false);
    });

    it('rejects a frame whose declared length exceeds the buffer', () => {
      // Long enough to pass the header check, so this hits the frameLen branch --
      // the one a dropped fragment actually produces.
      expect(
        makeAdapter().parseCharNotification(REC_CHR, Buffer.from('55aa24000611', 'hex')),
      ).toBeNull();
    });

    it('ignores in-band status and ack frames', () => {
      const adapter = makeAdapter();
      // 0x20 status and 0x22 ack, both with valid checksums.
      expect(
        adapter.parseCharNotification(REC_CHR, Buffer.from('55aa200005000101000026', 'hex')),
      ).toBeNull();
      expect(
        adapter.parseCharNotification(REC_CHR, Buffer.from('55aa2200021f0143', 'hex')),
      ).toBeNull();
    });
  });

  describe('fragmented 0x25 impedance record', () => {
    it('reassembles AD/AE/AF and decodes the report-validated reading', () => {
      const adapter = makeAdapter();
      const [first, mid, last] = REPORT_RECORD;

      // Neither of the first two fragments may yield a reading on its own.
      expect(adapter.parseCharNotification(REC_CHR, first)).toBeNull();
      expect(adapter.parseCharNotification(REC_CHR, mid)).toBeNull();

      const r = adapter.parseCharNotification(REC_CHR, last);
      expect(r).not.toBeNull();
      expect(r!.weight).toBeCloseTo(REPORT_WEIGHT, 2);
      expect(r!.impedance).toBeCloseTo(REPORT_LEG_TO_LEG, 1);
      // A record alone is enough to complete and resolve immediately.
      expect(adapter.isComplete(r!)).toBe(true);
      expect(adapter.isFinal(r!)).toBe(true);
    });

    it('decodes a second independent record (83.00 kg, 538.6 Ohm)', () => {
      const r = feed(makeAdapter(), RECORD_2);
      expect(r!.weight).toBeCloseTo(83.0, 2);
      expect(r!.impedance).toBeCloseTo(538.6, 1);
    });

    it('does not warn on a physiologically sane record', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      feed(makeAdapter(), REPORT_RECORD);
      // Trunk far below the limbs and 100 kHz below 20 kHz in every segment.
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('drops a middle or last fragment with no preceding first fragment', () => {
      const adapter = makeAdapter();
      const [, mid, last] = REPORT_RECORD;
      expect(adapter.parseCharNotification(REC_CHR, mid)).toBeNull();
      expect(adapter.parseCharNotification(REC_CHR, last)).toBeNull();
      expect(adapter.isComplete({ weight: 82.4, impedance: 548.1 })).toBe(false);
    });

    it('recovers when a new record starts before the previous one finished', () => {
      const adapter = makeAdapter();
      adapter.parseCharNotification(REC_CHR, REPORT_RECORD[0]); // abandoned midway
      const r = feed(adapter, RECORD_2);
      expect(r!.impedance).toBeCloseTo(538.6, 1);
    });

    it('does not splice a fragment belonging to a different sequence', () => {
      const adapter = makeAdapter();
      const [first, mid, last] = REPORT_RECORD;
      adapter.parseCharNotification(REC_CHR, first);
      // Same middle fragment relabelled to seq 0x09: no partial exists for it.
      const strayMid = Buffer.from(mid);
      strayMid[1] = 0x09;
      expect(adapter.parseCharNotification(REC_CHR, strayMid)).toBeNull();
      // The real record still completes untouched.
      adapter.parseCharNotification(REC_CHR, mid);
      const r = adapter.parseCharNotification(REC_CHR, last);
      expect(r!.impedance).toBeCloseTo(REPORT_LEG_TO_LEG, 1);
    });

    it('refuses a record whose channel count is not 10 rather than guessing', () => {
      // Same record with the count byte (payload offset 6) forced to 8.
      const bytes = Buffer.concat(REPORT_RECORD.map((f) => f.subarray(3)));
      bytes[5 + 6] = 0x08;
      let sum = 0;
      for (let i = 0; i < bytes.length - 1; i++) sum += bytes[i];
      bytes[bytes.length - 1] = sum & 0xff; // keep the checksum valid
      expect(makeAdapter().parseCharNotification(REC_CHR, bytes)).toBeNull();
    });
  });

  describe('completion gating', () => {
    it('ignores live frames after the measurement has settled', () => {
      // The handler holds the link open for the record and HoldTimer replaces the
      // held reading on every call, so a step-off weight must not become a reading.
      const adapter = makeAdapter();
      adapter.parseCharNotification(REC_CHR, FINAL); // 83.00 kg settles
      // 55AA 21 len=5 payload=01 00 00 01 f4 -> 5.00 kg, a plausible step-off.
      const stepOff = Buffer.from('55aa2100050100000' + '1f4', 'hex');
      const sum = [...stepOff.subarray(0, 10)].reduce((a, b) => a + b, 0) & 0xff;
      const framed = Buffer.concat([stepOff.subarray(0, 10), Buffer.from([sum])]);
      expect(adapter.parseCharNotification(LIVE_CHR, framed)).toBeNull();
    });

    it('ignores live frames arriving before onConnected has reset the singleton', () => {
      // subscribeAndInit subscribes notify chars BEFORE calling onConnected, so a
      // new session's first frames land while the previous session's state stands.
      const adapter = makeAdapter();
      feed(adapter, REPORT_RECORD); // session A completes: finished + composition
      // Session B starts; no onConnected yet.
      expect(adapter.parseCharNotification(LIVE_CHR, LIVE)).toBeNull();
    });

    it("never resolves a live frame with a previous record's impedance", () => {
      const adapter = makeAdapter();
      feed(adapter, REPORT_RECORD);
      adapter.onConnected(mockCtx());
      const live = adapter.parseCharNotification(LIVE_CHR, LIVE)!;
      expect(live.impedance).toBe(0);
      expect(adapter.isFinal(live)).toBe(false);
    });

    it('runs a full session: live -> final -> record', () => {
      const adapter = makeAdapter();
      adapter.parseCharNotification(LIVE_CHR, LIVE);
      const settled = adapter.parseCharNotification(REC_CHR, FINAL)!;
      expect(adapter.isComplete(settled)).toBe(true);
      expect(adapter.isFinal(settled)).toBe(false); // hold opens here

      const rich = feed(adapter, RECORD_2)!;
      expect(adapter.isFinal(rich)).toBe(true); // resolves early
      expect(rich.impedance).toBeCloseTo(538.6, 1);
    });

    it('resets state on reconnect (the adapter instance is a shared singleton)', () => {
      const adapter = makeAdapter();
      adapter.parseCharNotification(REC_CHR, FINAL);
      expect(adapter.isComplete({ weight: 83, impedance: 0 })).toBe(true);
      adapter.onConnected(mockCtx());
      expect(adapter.isComplete({ weight: 83, impedance: 0 })).toBe(false);
    });

    it('does not leak impedance from a previous session after reconnect', () => {
      const adapter = makeAdapter();
      feed(adapter, REPORT_RECORD);
      adapter.onConnected(mockCtx());
      const live = adapter.parseCharNotification(LIVE_CHR, LIVE)!;
      expect(live.impedance).toBe(0);
    });
  });

  describe('under-18 profiles (partial trailer)', () => {
    it("still uses the scale's body fat when skeletal muscle is absent", () => {
      const adapter = makeAdapter();
      const reading = feed(adapter, KID_RECORD)!;
      expect(reading.weight).toBeCloseTo(32.65, 2);
      expect(reading.impedance).toBeCloseTo(801.3, 1); // 403.4 + 397.9 @20 kHz

      const payload = adapter.computeMetrics(reading, KID_PROFILE);
      expect(payload.bodyFatPercent).toBeCloseTo(12.6, 1);
      expect(payload.bmi).toBeCloseTo(14.51, 2); // trailer says 14.5
      assertPayloadRanges(payload);
    });

    it('never publishes the zeroed visceral rating as a real value', () => {
      const adapter = makeAdapter();
      const payload = adapter.computeMetrics(feed(adapter, KID_RECORD)!, KID_PROFILE);
      // Renpho's visceral scale starts at 1, so 0 means "not measured"; passing it
      // through would have buildPayload clamp it to a bogus 1.
      expect(payload.visceralFat).toBeGreaterThan(1);
    });

    it('does not override the physique rating from a zeroed skeletal muscle', () => {
      const adapter = makeAdapter();
      const reading = feed(adapter, KID_RECORD)!;
      const payload = adapter.computeMetrics(reading, KID_PROFILE);
      // 0% would compute a rating from 0 kg of muscle; the shared estimate stands.
      const shared = buildPayload(32.65, 801.3, { fat: 12.6 }, KID_PROFILE);
      expect(payload.physiqueRating).toBe(shared.physiqueRating);
    });

    it('leaves bone to the shared default below 18 but still calibrates water', () => {
      // The vendor app prints "--" for a child's bone mass, so the adult ratio has
      // nothing to be checked against; hydration is confirmed on the child report
      // (20.93 kg against a fat-free mass of 28.54) so it applies at every age.
      const adapter = makeAdapter();
      const payload = adapter.computeMetrics(feed(adapter, KID_RECORD)!, KID_PROFILE);
      const ffm = 32.65 * (1 - payload.bodyFatPercent / 100);
      expect(payload.boneMass).toBeCloseTo(ffm * 0.042, 2);
      expect((payload.waterPercent * 32.65) / 100).toBeCloseTo(20.93, 1);
    });

    it('reproduces the exported child report', () => {
      // Renpho app, 20 Aug 2026 17:11 -- 32.65 kg at 150 cm, age 10.
      const adapter = makeAdapter();
      const payload = adapter.computeMetrics(feed(adapter, KID_RECORD)!, KID_PROFILE);
      expect(payload.weight).toBeCloseTo(32.65, 2);
      expect(payload.bodyFatPercent).toBeCloseTo(12.6, 1);
      expect(payload.bmi).toBeCloseTo(14.51, 2); // report prints 14.5
      // Report: fat mass 4.11, fat-free mass 28.54, water 20.93 / 64.1%.
      expect((payload.bodyFatPercent * 32.65) / 100).toBeCloseTo(4.11, 2);
      expect(32.65 - (payload.bodyFatPercent * 32.65) / 100).toBeCloseTo(28.54, 2);
      expect(payload.waterPercent).toBeCloseTo(64.1, 1);
      assertPayloadRanges(payload);
    });

    it('starts calibrating bone at 18 and above', () => {
      const adapter = makeAdapter();
      const payload = adapter.computeMetrics(feed(adapter, KID_RECORD)!, {
        ...KID_PROFILE,
        age: 18,
      });
      const ffm = 32.65 * (1 - payload.bodyFatPercent / 100);
      expect(payload.boneMass).toBeCloseTo(ffm * 0.0666, 2);
    });

    it('rejects a record whose measurement did not take (all channels zero)', () => {
      const adapter = makeAdapter();
      // Zero impedance fails the leg-to-leg range check, so no reading is produced
      // and the settled 0x24 weight is what resolves.
      expect(feed(adapter, EMPTY_RECORD)).toBeNull();
    });
  });

  describe('computeMetrics()', () => {
    const profile = defaultProfile({ height: 185, age: 45, gender: 'male' });

    it('produces an in-range payload from a bare weight+impedance reading', () => {
      const payload = makeAdapter().computeMetrics(
        { weight: REPORT_WEIGHT, impedance: REPORT_LEG_TO_LEG },
        profile,
      );
      expect(payload.weight).toBeCloseTo(REPORT_WEIGHT, 2);
      expect(payload.impedance).toBeCloseTo(REPORT_LEG_TO_LEG, 1);
      assertPayloadRanges(payload);
    });

    it("publishes the scale's own composition from the record trailer", () => {
      const adapter = makeAdapter();
      const reading = feed(adapter, REPORT_RECORD)!;
      const payload = adapter.computeMetrics(reading, profile);

      // Straight from the trailer, not estimated: this is what the app displays.
      expect(payload.bodyFatPercent).toBeCloseTo(23.0, 1);
      expect(payload.visceralFat).toBe(7);
      assertPayloadRanges(payload);
    });

    it('reads the skeletal muscle field as a rate, not a mass', () => {
      // Raw 438 on the 82.40 kg record. The app labels this "Skeletal Muscle
      // Percentage 43.8" and shows the mass as 43.8 * 82.40 / 100 = 36.09 kg.
      // Read as kilograms it would pass every range check while being wrong, so
      // pin the interpretation through the physique rating it feeds -- the two
      // readings straddle the 0.45 * weight threshold here.
      const adapter = makeAdapter();
      const reading = feed(adapter, REPORT_RECORD)!;
      const payload = adapter.computeMetrics(reading, { ...profile, height: 180 });

      const asRate = computePhysiqueRating(payload.bodyFatPercent, (43.8 * 82.4) / 100, 82.4);
      const asMass = computePhysiqueRating(payload.bodyFatPercent, 43.8, 82.4);
      expect(asRate).not.toBe(asMass); // the two interpretations are distinguishable
      expect(payload.physiqueRating).toBe(asRate);
    });

    // Both reports were exported from the Renpho app for weigh-ins whose records
    // are decoded above, so these are end-to-end checks against vendor output.
    it('reproduces the 180 cm exported report (the calibration configuration)', () => {
      // Report 20 Aug 2026 07:17:02 -- 82.40 kg at 180 cm, age 45, male.
      const adapter = makeAdapter();
      const reading = feed(adapter, REPORT_RECORD)!;
      const payload = adapter.computeMetrics(reading, { ...profile, height: 180 });
      const W = 82.4;

      expect(payload.weight).toBeCloseTo(82.4, 2);
      expect(payload.bodyFatPercent).toBeCloseTo(23.0, 1);
      expect(payload.visceralFat).toBe(7);
      expect(payload.bmi).toBeCloseTo(25.43, 2); // report prints 25.4
      // Report: fat mass 18.95, fat-free mass 63.45, bone 4.20, water 46.47,
      // muscle 59.16, skeletal muscle 36.09.
      expect((payload.bodyFatPercent * W) / 100).toBeCloseTo(18.95, 2);
      expect(W - (payload.bodyFatPercent * W) / 100).toBeCloseTo(63.45, 2);
      // Midpoint-fitted, so both reports sit ~0.03/0.05 kg either side.
      expect(Math.abs(payload.boneMass - 4.2)).toBeLessThan(0.05);
      expect(Math.abs((payload.waterPercent * W) / 100 - 46.47)).toBeLessThan(0.07);
      // The vendor's muscle mass is not exactly fat-free mass minus bone; it sits
      // within 0.1 kg of it on both reports, so bound it rather than equate it.
      expect(Math.abs(payload.muscleMass - 59.16)).toBeLessThan(0.1);
      assertPayloadRanges(payload);
    });

    it('stays close on the second exported report at a different height', () => {
      // Report 20 Aug 2026 09:33:03 -- 83.00 kg at 185 cm. The ratios are the
      // midpoint of this report and the 180 cm one, so both sit slightly either
      // side; this pins how far, so a future recalibration cannot drift.
      const adapter = makeAdapter();
      const reading = feed(adapter, RECORD_2)!;
      const payload = adapter.computeMetrics(reading, { ...profile, height: 185 });
      const W = 83.0;

      expect(payload.bodyFatPercent).toBeCloseTo(19.2, 1);
      expect(payload.visceralFat).toBe(5);
      expect(payload.bmi).toBeCloseTo(24.25, 2);
      expect(W - (payload.bodyFatPercent * W) / 100).toBeCloseTo(67.06, 2); // exact
      expect(Math.abs(payload.boneMass - 4.5)).toBeLessThan(0.05);
      expect(Math.abs((payload.waterPercent * W) / 100 - 49.22)).toBeLessThan(0.07);
      assertPayloadRanges(payload);
    });

    it('leaves bone and water to the shared defaults with no record', () => {
      // The calibrated ratios are only justified when the scale sent a record.
      const payload = makeAdapter().computeMetrics(
        { weight: 83.0, impedance: 0 },
        { ...profile, height: 185 },
      );
      const lean = 83.0 * (1 - payload.bodyFatPercent / 100);
      expect(payload.boneMass).toBeCloseTo(lean * 0.042, 2);
      expect(payload.waterPercent).toBeCloseTo(((lean * 0.73) / 83.0) * 100, 2);
    });

    it('publishes the chronological age rather than an invented penalty', () => {
      // buildPayload's derivation reduces to age + trunc((age-25)/3) -- weight,
      // height and body fat all cancel -- so it can only ever add a penalty. The
      // scale sends no metabolic age, so assert no deviation instead.
      const adapter = makeAdapter();
      const withRecord = adapter.computeMetrics(feed(adapter, REPORT_RECORD)!, profile);
      expect(withRecord.metabolicAge).toBe(45);
      expect(buildPayload(REPORT_WEIGHT, 0, { fat: 23.0 }, profile).metabolicAge).toBe(51);
    });

    it('does not publish a metabolic age below the shared floor', () => {
      const adapter = makeAdapter();
      const payload = adapter.computeMetrics(feed(adapter, KID_RECORD)!, KID_PROFILE);
      expect(payload.metabolicAge).toBe(12); // age 10, floored
    });

    it('computes BMR from measured lean mass, matching all three reports', () => {
      const cases: Array<[Buffer[], typeof profile, number, number]> = [
        [REPORT_RECORD, { ...profile, height: 180 }, 82.4, 1739],
        [RECORD_2, { ...profile, height: 185 }, 83.0, 1819],
        [KID_RECORD, KID_PROFILE, 32.65, 986],
      ];
      for (const [frags, prof, weight, reported] of cases) {
        const adapter = makeAdapter();
        const payload = adapter.computeMetrics(feed(adapter, frags)!, prof);
        const ffm = weight - (payload.bodyFatPercent * weight) / 100;
        expect(payload.bmr).toBe(Math.trunc(370 + 21.6 * ffm));
        expect(Math.abs(payload.bmr - reported)).toBeLessThan(2);
      }
    });

    it('applies athlete mode locally, since the scale is never told about it', () => {
      const adapter = makeAdapter();
      const reading = { weight: REPORT_WEIGHT, impedance: REPORT_LEG_TO_LEG };
      const normal = adapter.computeMetrics(reading, { ...profile, isAthlete: false });
      const athlete = adapter.computeMetrics(reading, { ...profile, isAthlete: true });
      expect(athlete.bodyFatPercent).toBeLessThan(normal.bodyFatPercent);
      expect(athlete.bmr).toBeGreaterThan(normal.bmr);
      assertPayloadRanges(athlete);
    });
  });
});
