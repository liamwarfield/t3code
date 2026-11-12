/** Everything is synthesized so the machine ships no audio assets. */
export interface SlotAudio {
  readonly resume: () => void;
  readonly setMuted: (muted: boolean) => void;
  readonly ratchet: (progress: number) => void;
  readonly leverClunk: () => void;
  readonly motorStart: () => void;
  readonly motorStop: () => void;
  readonly tick: (speed: number) => void;
  readonly reelStop: (index: number, jackpot?: boolean) => void;
  readonly motorDuck: () => void;
  readonly revealPop: (index: number) => void;
  readonly heatPip: (count: number) => void;
  readonly agiChoir: () => void;
  readonly heartbeat: (intensity: number) => void;
  readonly droneStart: () => void;
  readonly droneStop: () => void;
  readonly nearMiss: () => void;
  readonly win: (level: number) => void;
  readonly countTick: (progress: number) => void;
  readonly jester: () => void;
  /** Music bed, coin clinks and a closing ka-ching that cover the whole counter roll-up. */
  readonly payout: (
    level: number,
    durationMs: number,
    jester: boolean,
    delayMs?: number,
    endKaching?: boolean,
  ) => void;
  /** Timpani roll under the jackpot blackout. */
  readonly drumroll: (durationMs: number) => void;
  /** Brass stabs reserved for jackpots, so mega never sounds the same. */
  readonly jackpotFanfare: () => void;
  readonly stopPayout: () => void;
  /** Ducks the payout band while the counter stalls, then brings it back. */
  readonly holdPayout: (held: boolean) => void;
  readonly tierHint: (level: number) => void;
  readonly hotStreak: () => void;
  readonly honk: () => void;
  readonly womp: () => void;
  readonly limitReached: () => void;
  readonly kaching: () => void;
  /** The low-end hit under a big reveal: what makes a jackpot feel heavier than a spin. */
  readonly subBoom: (level: number) => void;
  /** HTTP 429: the reels seize with a buzzer and a spun-down motor. */
  readonly rateLimit: () => void;
  readonly motorResume: () => void;
  readonly dispose: () => void;
}

const NOTE = (semitonesFromA4: number) => 440 * 2 ** (semitonesFromA4 / 12);

export function createSlotAudio(): SlotAudio {
  const AudioContextCtor = globalThis.AudioContext as typeof AudioContext | undefined;
  if (!AudioContextCtor) return silentAudio;
  const ctx = new AudioContextCtor();
  const master = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  // Fanfares stack many voices; a hard knee keeps the peaks well clear of clipping.
  compressor.threshold.value = -12;
  compressor.knee.value = 4;
  // A gentle ratio keeps the build quieter than the payoff instead of squashing them together.
  compressor.ratio.value = 4;
  compressor.attack.value = 0.002;
  master.gain.value = 0.5;
  master.connect(compressor).connect(ctx.destination);
  // A short slap-back room on bells and stings, so the synths sit in a space instead of a void.
  const room = ctx.createGain();
  const roomDelay = ctx.createDelay(0.5);
  const roomFeedback = ctx.createGain();
  const roomTone = ctx.createBiquadFilter();
  room.gain.value = 0.28;
  roomDelay.delayTime.value = 0.11;
  roomFeedback.gain.value = 0.38;
  roomTone.type = "lowpass";
  roomTone.frequency.value = 2800;
  room.connect(roomDelay).connect(roomTone).connect(roomFeedback).connect(roomDelay);
  roomTone.connect(master);
  // A generated hall tail (decaying stereo noise) behind the room, so bells and brass bloom.
  const hall = ctx.createConvolver();
  const hallSeconds = 1.6;
  const impulse = ctx.createBuffer(2, Math.floor(ctx.sampleRate * hallSeconds), ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < data.length; index++) {
      data[index] = (Math.random() * 2 - 1) * (1 - index / data.length) ** 3.2;
    }
  }
  hall.buffer = impulse;
  const hallReturn = ctx.createGain();
  hallReturn.gain.value = 0.22;
  room.connect(hall).connect(hallReturn).connect(master);
  // Stings go dry to the master and wet to the room.
  const sting = ctx.createGain();
  sting.connect(master);
  sting.connect(room);

  let noiseBuffer: AudioBuffer | null = null;
  const noise = () => {
    if (!noiseBuffer) {
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    return source;
  };

  const envelope = (gain: GainNode, at: number, peak: number, attack: number, decay: number) => {
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  };

  const tone = (input: {
    type: OscillatorType;
    frequency: number;
    endFrequency?: number;
    at?: number;
    peak: number;
    attack?: number;
    decay: number;
    filter?: number;
    out?: AudioNode;
  }) => {
    const at = input.at ?? ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = input.type;
    osc.frequency.setValueAtTime(input.frequency, at);
    if (input.endFrequency) {
      osc.frequency.exponentialRampToValueAtTime(
        input.endFrequency,
        at + (input.attack ?? 0.005) + input.decay,
      );
    }
    envelope(gain, at, input.peak, input.attack ?? 0.005, input.decay);
    if (input.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = input.filter;
      osc.connect(filter).connect(gain);
    } else {
      osc.connect(gain);
    }
    gain.connect(input.out ?? master);
    osc.start(at);
    osc.stop(at + (input.attack ?? 0.005) + input.decay + 0.05);
  };

  const noiseHit = (input: {
    at?: number;
    peak: number;
    decay: number;
    frequency: number;
    q?: number;
    type?: BiquadFilterType;
    out?: AudioNode;
  }) => {
    const at = input.at ?? ctx.currentTime;
    const source = noise();
    const filter = ctx.createBiquadFilter();
    filter.type = input.type ?? "bandpass";
    filter.frequency.value = input.frequency;
    filter.Q.value = input.q ?? 1;
    const gain = ctx.createGain();
    envelope(gain, at, input.peak, 0.002, input.decay);
    source
      .connect(filter)
      .connect(gain)
      .connect(input.out ?? master);
    source.start(at, Math.random() * 0.5);
    source.stop(at + input.decay + 0.05);
  };

  /** Two-operator FM bell: the "ding" of every payout. */
  const bell = (
    frequency: number,
    at: number,
    peak = 0.22,
    decay = 1.2,
    out: AudioNode = master,
  ) => {
    const carrier = ctx.createOscillator();
    const modulator = ctx.createOscillator();
    const modGain = ctx.createGain();
    const gain = ctx.createGain();
    carrier.frequency.value = frequency;
    modulator.frequency.value = frequency * 3.5;
    modGain.gain.setValueAtTime(frequency * 2.2, at);
    modGain.gain.exponentialRampToValueAtTime(1, at + decay);
    modulator.connect(modGain).connect(carrier.frequency);
    envelope(gain, at, peak, 0.002, decay);
    carrier.connect(gain).connect(out);
    gain.connect(room);
    carrier.start(at);
    modulator.start(at);
    carrier.stop(at + decay + 0.1);
    modulator.stop(at + decay + 0.1);
  };

  let motor: { osc: OscillatorNode; lfo: OscillatorNode; gain: GainNode } | null = null;
  let drone: { oscs: OscillatorNode[]; gain: GainNode; tremolo: OscillatorNode } | null = null;
  let lastTick = 0;
  let lastRatchet = -1;
  let payoutBus: GainNode | null = null;
  // Each pull detunes the motor and drone a little, so no two spins sound identical.
  let pullDetune = 0;
  // One fixed key, so the win hook is the same phrase every time and players learn it.
  const PITCH = (semitonesFromA4: number) => NOTE(semitonesFromA4);

  // One struck-coin sample, computed once: inharmonic partials, a low body knock and a
  // bounce. Playing a buffer at varied rates gives coins weight that live oscillators lack.
  const coinBuffer = (() => {
    const length = Math.floor(ctx.sampleRate * 0.45);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const partials: ReadonlyArray<readonly [number, number, number]> = [
      [1, 1, 9],
      [2.32, 0.7, 12],
      [3.81, 0.5, 16],
      [5.4, 0.35, 22],
      [7.1, 0.22, 30],
      [9.2, 0.14, 38],
    ];
    const base = 1850;
    for (const strike of [0, 0.048]) {
      const start = Math.floor(strike * ctx.sampleRate);
      const gain = strike === 0 ? 1 : 0.45;
      for (let index = start; index < length; index++) {
        const t = (index - start) / ctx.sampleRate;
        let sample = 0;
        for (const [ratio, level, decay] of partials) {
          sample += level * Math.sin(2 * Math.PI * base * ratio * t) * Math.exp(-decay * t);
        }
        sample += 0.8 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-60 * t);
        if (t < 0.004) sample += (Math.random() * 2 - 1) * (1 - t / 0.004) * 1.4;
        data[index] = (data[index] ?? 0) + sample * gain * 0.28;
      }
    }
    return buffer;
  })();

  const coinClink = (at: number, out: AudioNode, peak = 0.14) => {
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = coinBuffer;
    source.playbackRate.value = 0.82 + Math.random() * 0.42;
    gain.gain.value = peak * 2.4;
    source.connect(gain).connect(out);
    source.start(at);
  };

  const kaching = (at: number, out: AudioNode) => {
    // Cash register: drawer rattle, then two bright bells.
    noiseHit({ at, peak: 0.5, decay: 0.08, frequency: 3000, q: 1.5, out });
    noiseHit({ at: at + 0.05, peak: 0.35, decay: 0.12, frequency: 5200, q: 3, out });
    bell(PITCH(27), at + 0.08, 0.32, 1.4, out);
    bell(PITCH(34), at + 0.16, 0.3, 1.8, out);
    [3, 10, 15, 19].forEach((semitone) =>
      tone({
        type: "sawtooth",
        frequency: PITCH(semitone),
        at: at + 0.08,
        peak: 0.07,
        attack: 0.01,
        decay: 1.4,
        filter: 3000,
        out,
      }),
    );
  };

  return {
    resume: () => {
      if (ctx.state === "suspended") void ctx.resume();
    },
    setMuted: (muted) => {
      master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.02);
    },
    ratchet: (progress) => {
      const notch = Math.floor(progress * 9);
      if (notch === lastRatchet) return;
      lastRatchet = notch;
      noiseHit({ peak: 0.35, decay: 0.03, frequency: 2600 + notch * 180, q: 6 });
      tone({ type: "square", frequency: 900 + notch * 60, peak: 0.05, decay: 0.02 });
    },
    leverClunk: () => {
      lastRatchet = -1;
      const at = ctx.currentTime;
      tone({ type: "sine", frequency: 140, endFrequency: 42, at, peak: 0.6, decay: 0.32 });
      noiseHit({ at, peak: 0.5, decay: 0.12, frequency: 700, q: 0.7 });
      noiseHit({ at: at + 0.02, peak: 0.25, decay: 0.05, frequency: 4200, q: 4 });
      tone({ type: "triangle", frequency: 1860, at: at + 0.015, peak: 0.12, decay: 0.25 });
      // The lever's spring snapping back: two detuned partials beat into a wobble.
      for (const frequency of [196, 203]) {
        tone({
          type: "triangle",
          frequency,
          endFrequency: frequency * 0.82,
          at: at + 0.14,
          peak: 0.07,
          decay: 0.42,
          filter: 1400,
        });
      }
    },
    motorStart: () => {
      if (motor) return;
      const at = ctx.currentTime;
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      pullDetune = (Math.random() - 0.5) * 4;
      osc.frequency.setValueAtTime(38 * 2 ** (pullDetune / 12), at);
      osc.frequency.exponentialRampToValueAtTime(72 * 2 ** (pullDetune / 12), at + 0.35);
      lfo.frequency.value = 11;
      lfoGain.gain.value = 6;
      lfo.connect(lfoGain).connect(osc.frequency);
      filter.type = "lowpass";
      filter.frequency.value = 420;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.022, at + 0.2);
      osc.connect(filter).connect(gain).connect(master);
      osc.start(at);
      lfo.start(at);
      motor = { osc, lfo, gain };
    },
    motorStop: () => {
      if (!motor) return;
      const at = ctx.currentTime;
      motor.osc.frequency.exponentialRampToValueAtTime(30, at + 0.4);
      motor.gain.gain.setTargetAtTime(0.0001, at, 0.12);
      motor.osc.stop(at + 0.6);
      motor.lfo.stop(at + 0.6);
      motor = null;
    },
    tick: (speed) => {
      const now = ctx.currentTime;
      if (now - lastTick < 0.028) return;
      lastTick = now;
      const clamped = Math.max(0, Math.min(1, speed));
      // A pawl clacking over a reel peg: a resonant noise click with a little body under it.
      noiseHit({
        peak: 0.1 + (1 - clamped) * 0.08,
        decay: 0.014,
        frequency: 1500 + clamped * 1400,
        q: 5,
      });
      tone({
        type: "sine",
        frequency: 240 + clamped * 120,
        endFrequency: 110,
        peak: 0.03 + (1 - clamped) * 0.04,
        decay: 0.03,
      });
    },
    reelStop: (index, jackpot = false) => {
      const at = ctx.currentTime;
      // Root, third, fifth: the stops climb a chord, and a jackpot line resolves to the octave.
      const step = [15, 19, jackpot ? 27 : 22][index] ?? 15;
      // Sub thump: the stop's weight lives below 100 Hz, heavier on the last reel.
      tone({
        type: "sine",
        frequency: 78,
        endFrequency: 42,
        at,
        peak: 0.5 + index * 0.2,
        decay: 0.16,
      });
      tone({
        type: "sine",
        frequency: 190 - index * 22,
        endFrequency: 55,
        at,
        peak: 0.8,
        decay: 0.2,
      });
      noiseHit({ at, peak: 0.45, decay: 0.05, frequency: 900, q: 0.7 });
      noiseHit({ at, peak: 0.25, decay: 0.03, frequency: 3800, q: 2 });
      tone({ type: "triangle", frequency: PITCH(step), at: at + 0.01, peak: 0.16, decay: 0.4 });
      bell(PITCH(step + 12), at + 0.01, 0.06, 0.5);
    },
    motorDuck: () => {
      motor?.gain.gain.setTargetAtTime(0.015, ctx.currentTime, 0.08);
    },
    revealPop: (index) => {
      const at = ctx.currentTime;
      // Each pop is the next note of the machine's hook, so reveals and tier crossings sing it.
      const semitone = [19, 24, 28, 31][index] ?? 31;
      noiseHit({ at, peak: 0.35, decay: 0.12, frequency: 2400, q: 1.2 });
      tone({ type: "sine", frequency: 120, endFrequency: 50, at, peak: 0.5, decay: 0.15 });
      bell(PITCH(semitone), at, 0.22, 1);
      bell(PITCH(semitone + 7), at + 0.04, 0.12, 0.8);
    },
    heatPip: (count) => {
      const at = ctx.currentTime;
      [0, 4, 7].forEach((interval, index) =>
        tone({
          type: "square",
          frequency: PITCH(10 + count * 2 + interval),
          at: at + index * 0.05,
          peak: 0.06,
          decay: 0.12,
          filter: 3000,
        }),
      );
    },
    agiChoir: () => {
      const at = ctx.currentTime;
      // A synthetic "aaah": stacked vibrato saws through a vowel-ish bandpass.
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 900;
      filter.Q.value = 0.8;
      const gain = ctx.createGain();
      envelope(gain, at, 0.35, 0.6, 3.2);
      filter.connect(gain).connect(sting);
      for (const semitone of [-9, -5, -2, 3, 7, 10, 15]) {
        const osc = ctx.createOscillator();
        const vibrato = ctx.createOscillator();
        const vibratoGain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.value = PITCH(semitone);
        vibrato.frequency.value = 5 + Math.random();
        vibratoGain.gain.value = PITCH(semitone) * 0.008;
        vibrato.connect(vibratoGain).connect(osc.frequency);
        osc.connect(filter);
        osc.start(at);
        vibrato.start(at);
        osc.stop(at + 4);
        vibrato.stop(at + 4);
      }
    },
    heartbeat: (intensity) => {
      const at = ctx.currentTime;
      const peak = 0.5 + intensity * 0.5;
      tone({ type: "sine", frequency: 70, endFrequency: 40, at, peak, decay: 0.16 });
      tone({
        type: "sine",
        frequency: 62,
        endFrequency: 36,
        at: at + 0.17,
        peak: peak * 0.7,
        decay: 0.2,
      });
    },
    droneStart: () => {
      if (drone) return;
      const at = ctx.currentTime;
      const gain = ctx.createGain();
      const tremolo = ctx.createOscillator();
      const tremoloGain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(500, at);
      filter.frequency.exponentialRampToValueAtTime(3800, at + 3);
      tremolo.frequency.setValueAtTime(5, at);
      tremolo.frequency.linearRampToValueAtTime(14, at + 3);
      // Depth stays under the drone's own level, so the tremolo pulses instead of phase-flipping.
      tremoloGain.gain.value = 0.012;
      tremolo.connect(tremoloGain).connect(gain.gain);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.028, at + 0.6);
      const oscs = [0, 7, 12].map((interval) => {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(PITCH(-24 + interval + pullDetune), at);
        osc.frequency.exponentialRampToValueAtTime(PITCH(-12 + interval + pullDetune), at + 3.2);
        osc.connect(filter);
        osc.start(at);
        return osc;
      });
      filter.connect(gain).connect(master);
      tremolo.start(at);
      drone = { oscs, gain, tremolo };
    },
    droneStop: () => {
      if (!drone) return;
      const at = ctx.currentTime;
      drone.gain.gain.cancelScheduledValues(at);
      drone.gain.gain.setTargetAtTime(0.0001, at, 0.05);
      for (const osc of drone.oscs) osc.stop(at + 0.3);
      drone.tremolo.stop(at + 0.3);
      drone = null;
    },
    nearMiss: () => {
      const at = ctx.currentTime;
      // Sad trombone: three falling steps, the last one wobbling down.
      [0, -1, -2].forEach((step, index) => {
        tone({
          type: "sawtooth",
          frequency: PITCH(-5 + step),
          at: at + index * 0.32,
          peak: 0.34,
          attack: 0.03,
          decay: 0.28,
          filter: 1400,
          out: sting,
        });
      });
      tone({
        type: "sawtooth",
        frequency: PITCH(-8),
        endFrequency: PITCH(-11),
        at: at + 0.96,
        peak: 0.4,
        attack: 0.03,
        decay: 0.9,
        filter: 1200,
        out: sting,
      });
    },
    win: (level) => {
      const at = ctx.currentTime;
      if (level >= 2) {
        // The machine's signature hook, stepped up a tone per tier, so wins are known by ear.
        const lift = (level - 2) * 2;
        const hook: ReadonlyArray<readonly [number, number, number]> = [
          [7, 0, 0.1],
          [12, 0.1, 0.1],
          [16, 0.2, 0.1],
          [19, 0.3, 0.22],
          [16, 0.52, 0.1],
          [24, 0.62, 0.7],
        ];
        for (const [semitone, offset, length] of hook) {
          tone({
            type: "square",
            frequency: PITCH(semitone + lift),
            at: at + offset,
            peak: 0.09,
            decay: length,
            filter: 3800,
            out: sting,
          });
          bell(PITCH(semitone + lift + 12), at + offset, 0.09, length + 0.4);
        }
        tone({ type: "sine", frequency: PITCH(lift - 17), at, peak: 0.4, decay: 1.2 });
        return;
      }
      const arpeggio = [3, 7, 10, 15, 19, 22, 27];
      const notes = arpeggio.slice(0, 3 + Math.min(4, level));
      notes.forEach((semitone, index) => {
        tone({
          type: "square",
          frequency: PITCH(semitone),
          at: at + index * 0.075,
          peak: 0.07,
          decay: 0.16,
          filter: 4200,
        });
        bell(PITCH(semitone + 12), at + index * 0.075, 0.07 + level * 0.015, 0.6);
      });
      if (level >= 2) {
        const chordAt = at + notes.length * 0.075 + 0.05;
        [3, 7, 10, 15].forEach((semitone) => {
          tone({
            type: "sawtooth",
            frequency: PITCH(semitone),
            at: chordAt,
            peak: 0.06,
            attack: 0.02,
            decay: 1.1 + level * 0.2,
            filter: 2600,
          });
        });
        for (let index = 0; index < level * 3; index++) {
          bell(PITCH(27 + ((index * 5) % 12)), chordAt + index * 0.09, 0.08, 0.9);
        }
      }
      if (level >= 4) {
        tone({ type: "sine", frequency: 55, endFrequency: 30, at, peak: 0.9, decay: 1.4 });
        noiseHit({ at, peak: 0.35, decay: 1.6, frequency: 8000, type: "highpass" });
      }
    },
    countTick: (progress) => {
      const now = ctx.currentTime;
      if (now - lastTick < 0.035) return;
      lastTick = now;
      // Ticks climb the major pentatonic in the pull's key, so the count sings with the music.
      const scale = [0, 2, 4, 7, 9];
      const step = Math.floor(progress * 10);
      const semitone = 12 * Math.floor(step / 5) + scale[step % 5]!;
      tone({ type: "triangle", frequency: PITCH(7 + semitone), peak: 0.11, decay: 0.05 });
    },
    jester: () => {
      const at = ctx.currentTime;
      for (let index = 0; index < 18; index++) {
        bell(PITCH(31 + ((index * 7) % 9)), at + index * 0.07 + Math.random() * 0.02, 0.09, 0.4);
      }
      // Kazoo slide whistle: up, down, up again.
      const osc = ctx.createOscillator();
      const vibrato = ctx.createOscillator();
      const vibratoGain = ctx.createGain();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(PITCH(0), at + 0.2);
      osc.frequency.exponentialRampToValueAtTime(PITCH(12), at + 0.55);
      osc.frequency.exponentialRampToValueAtTime(PITCH(-3), at + 0.9);
      osc.frequency.exponentialRampToValueAtTime(PITCH(15), at + 1.3);
      osc.frequency.exponentialRampToValueAtTime(PITCH(-5), at + 1.8);
      osc.frequency.exponentialRampToValueAtTime(PITCH(19), at + 2.2);
      vibrato.frequency.value = 7;
      vibratoGain.gain.value = 18;
      vibrato.connect(vibratoGain).connect(osc.frequency);
      filter.type = "bandpass";
      filter.frequency.value = 1300;
      filter.Q.value = 2.5;
      envelope(gain, at + 0.2, 0.5, 0.05, 2.0);
      osc.connect(filter).connect(gain).connect(sting);
      osc.start(at + 0.2);
      vibrato.start(at + 0.2);
      osc.stop(at + 2.4);
      vibrato.stop(at + 2.4);
    },
    payout: (level, durationMs, jester, delayMs = 0, endKaching = true) => {
      payoutBus?.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.03);
      const bus = ctx.createGain();
      const at = ctx.currentTime + 0.02 + delayMs / 1000;
      // Starts ducked under whatever sting opens the payout, then swells in.
      bus.gain.setValueAtTime(0.25, ctx.currentTime);
      bus.gain.linearRampToValueAtTime(0.6 + level * 0.12, at + 0.7);
      bus.connect(master);
      payoutBus = bus;
      const duration = durationMs / 1000;
      // Each payout lands in a slightly different key, so the tenth pull doesn't sound like the first.
      // 16th-note arpeggio over I-vi-IV-V, shifting up a semitone every bar: the counter's climb.
      const step = level >= 3 ? 0.075 : 0.09;
      const progression = jester
        ? [
            [0, 3, 7],
            [1, 4, 8],
            [-1, 2, 6],
            [0, 4, 7],
          ]
        : [
            [0, 4, 7],
            [-3, 0, 4],
            [-7, -3, 0],
            [-5, -1, 2],
          ];
      const steps = Math.floor(duration / step);
      for (let index = 0; index < steps; index++) {
        // A plain win only gets a sparse tinkle; the full band arrives at BIG and above.
        if (level <= 1 && index % 2 === 1) continue;
        const bar = Math.floor(index / 8);
        const chord = progression[bar % progression.length]!;
        const lift = bar + (level >= 3 ? 12 : 7);
        const note = chord[index % 3]! + 12 * Math.floor((index % 8) / 3) + lift;
        const noteAt = at + index * step;
        tone({
          type: jester ? "sawtooth" : "square",
          frequency: PITCH(note),
          at: noteAt,
          peak: 0.05,
          decay: step * 1.6,
          filter: jester ? 1600 : 3600,
          out: bus,
        });
        if (index % 4 === 0 && level >= 2) {
          // A sub under each bar gives the cabinet weight; the bells alone read thin.
          tone({
            type: "sine",
            frequency: PITCH(chord[0]! + lift - 36),
            at: noteAt,
            peak: 0.34,
            attack: 0.01,
            decay: step * 4,
            out: bus,
          });
          if (level >= 3) {
            tone({
              type: "sawtooth",
              frequency: PITCH(chord[0]! + lift - 36),
              at: noteAt,
              peak: 0.12,
              decay: step * 3,
              filter: 500,
              out: bus,
            });
          }
          tone({
            type: "triangle",
            frequency: PITCH(chord[0]! + lift - 24),
            at: noteAt,
            peak: 0.22,
            decay: step * 3.5,
            out: bus,
          });
        }
        if (index % 2 === 0 && level >= 2)
          noiseHit({
            at: noteAt,
            peak: 0.035,
            decay: 0.03,
            frequency: 9000,
            type: "highpass",
            out: bus,
          });
      }
      // A coin hopper rattling out the payout under the music.
      if (level >= 2) {
        const grains = Math.floor(duration * (14 + level * 8));
        for (let index = 0; index < grains; index++) {
          noiseHit({
            at: at + Math.random() * duration,
            peak: 0.04 + Math.random() * 0.03,
            decay: 0.012,
            frequency: 2200 + Math.random() * 1800,
            q: 4,
            out: bus,
          });
        }
      }
      const clinks = Math.floor(duration * (6 + level * 6));
      for (let index = 0; index < clinks; index++) {
        coinClink(at + Math.random() * duration, bus, 0.06 + level * 0.02);
      }
      if (endKaching) kaching(at + duration, bus);
    },
    drumroll: (durationMs) => {
      const at = ctx.currentTime;
      const duration = durationMs / 1000;
      const strokes = Math.floor(duration / 0.035);
      for (let index = 0; index < strokes; index++) {
        const strokeAt = at + index * 0.035;
        const swell = 0.1 + (index / strokes) * 0.35;
        tone({
          type: "sine",
          frequency: 92 + Math.random() * 6,
          endFrequency: 70,
          at: strokeAt,
          peak: swell,
          decay: 0.08,
        });
        noiseHit({ at: strokeAt, peak: swell * 0.4, decay: 0.05, frequency: 300, q: 0.8 });
      }
    },
    jackpotFanfare: () => {
      const at = ctx.currentTime;
      // Ta-ta-ta-TAAA on a major chord, then the IV, then home an octave up.
      const stabs: ReadonlyArray<readonly [number, ReadonlyArray<number>, number]> = [
        [0, [3, 7, 10], 0.12],
        [0.13, [3, 7, 10], 0.12],
        [0.26, [3, 7, 10], 0.12],
        [0.39, [8, 12, 15], 0.5],
        [0.95, [10, 14, 17], 0.3],
        [1.3, [15, 19, 22, 27], 1.6],
      ];
      for (const [offset, chord, length] of stabs) {
        for (const semitone of chord) {
          for (const detune of [-0.06, 0.06]) {
            tone({
              type: "sawtooth",
              frequency: PITCH(semitone + detune),
              at: at + offset,
              peak: 0.11,
              attack: 0.015,
              decay: length,
              filter: 2600,
              out: sting,
            });
          }
        }
        tone({
          type: "sine",
          frequency: PITCH(chord[0]! - 24),
          at: at + offset,
          peak: 0.5,
          decay: length + 0.2,
        });
      }
      tone({ type: "sine", frequency: 60, endFrequency: 28, at: at + 1.3, peak: 1, decay: 1.6 });
      noiseHit({ at: at + 1.3, peak: 0.45, decay: 2.2, frequency: 7000, type: "highpass" });
      for (let index = 0; index < 14; index++)
        bell(PITCH(27 + ((index * 7) % 12)), at + 1.3 + index * 0.06, 0.09, 1.2);
    },
    holdPayout: (held) => {
      payoutBus?.gain.setTargetAtTime(held ? 0.04 : 0.8, ctx.currentTime, 0.08);
    },
    stopPayout: () => {
      // A gentle release, so bell and ka-ching tails ring out instead of being chopped.
      payoutBus?.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.18);
      payoutBus = null;
    },
    tierHint: (level) => {
      const at = ctx.currentTime;
      const source = noise();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      filter.type = "bandpass";
      filter.Q.value = 4;
      filter.frequency.setValueAtTime(400, at);
      filter.frequency.exponentialRampToValueAtTime(2000 + level * 1800, at + 0.5);
      envelope(gain, at, 0.4, 0.25, 0.35);
      source.connect(filter).connect(gain).connect(master);
      source.start(at);
      source.stop(at + 0.7);
      [0, 4, 7, 12]
        .slice(0, level)
        .forEach((semitone, index) =>
          bell(PITCH(24 + semitone), at + 0.12 + index * 0.06, 0.09, 0.9),
        );
    },
    hotStreak: () => {
      const at = ctx.currentTime;
      [0, 7, 12].forEach((semitone) =>
        tone({
          type: "sawtooth",
          frequency: PITCH(semitone - 12),
          endFrequency: PITCH(semitone),
          at,
          peak: 0.12,
          attack: 0.05,
          decay: 0.9,
          filter: 2400,
        }),
      );
      noiseHit({ at, peak: 0.3, decay: 0.6, frequency: 1500, q: 0.5 });
    },
    honk: () => {
      const at = ctx.currentTime;
      [0, 0.32].forEach((offset, index) => {
        [0, 7].forEach((detune) =>
          tone({
            type: "sawtooth",
            frequency: PITCH(-14 - index * 3 + detune * 0.03),
            at: at + offset,
            peak: 0.42,
            attack: 0.01,
            decay: 0.26,
            filter: 900,
            out: sting,
          }),
        );
      });
    },
    womp: () => {
      tone({
        type: "sawtooth",
        frequency: PITCH(-2),
        endFrequency: PITCH(-17),
        peak: 0.22,
        attack: 0.02,
        decay: 0.8,
        filter: 1100,
      });
    },
    limitReached: () => {
      const at = ctx.currentTime;
      [0, 0.18, 0.36].forEach((offset) =>
        tone({
          type: "square",
          frequency: PITCH(-9),
          at: at + offset,
          peak: 0.1,
          decay: 0.12,
          filter: 1800,
        }),
      );
      tone({
        type: "sawtooth",
        frequency: PITCH(-14),
        endFrequency: PITCH(-26),
        at: at + 0.6,
        peak: 0.16,
        decay: 0.9,
        filter: 900,
      });
    },
    kaching: () => kaching(ctx.currentTime, master),
    subBoom: (level) => {
      const at = ctx.currentTime;
      tone({
        type: "sine",
        frequency: 62,
        endFrequency: 28,
        at,
        peak: 0.6 + level * 0.1,
        decay: 0.9 + level * 0.2,
      });
      tone({ type: "sine", frequency: 124, endFrequency: 50, at, peak: 0.3, decay: 0.3 });
      noiseHit({ at, peak: 0.3 + level * 0.05, decay: 0.35, frequency: 180, q: 0.7 });
    },
    motorResume: () => {
      motor?.osc.frequency.setTargetAtTime(72 * 2 ** (pullDetune / 12), ctx.currentTime, 0.1);
    },
    rateLimit: () => {
      const at = ctx.currentTime;
      motor?.osc.frequency.setTargetAtTime(20, at, 0.08);
      [0, 0.22].forEach((offset) =>
        tone({
          type: "square",
          frequency: PITCH(-17),
          at: at + offset,
          peak: 0.22,
          decay: 0.16,
          filter: 1200,
        }),
      );
      noiseHit({ at, peak: 0.4, decay: 0.15, frequency: 500, q: 0.8 });
    },
    dispose: () => {
      // Let the collect chime ring out after the machine closes.
      window.setTimeout(() => void ctx.close(), 1500);
    },
  };
}

const noop = () => {};
const silentAudio: SlotAudio = {
  resume: noop,
  setMuted: noop,
  ratchet: noop,
  leverClunk: noop,
  motorStart: noop,
  motorStop: noop,
  tick: noop,
  reelStop: noop,
  motorDuck: noop,
  revealPop: noop,
  heatPip: noop,
  agiChoir: noop,
  heartbeat: noop,
  droneStart: noop,
  droneStop: noop,
  nearMiss: noop,
  win: noop,
  countTick: noop,
  jester: noop,
  payout: noop,
  drumroll: noop,
  jackpotFanfare: noop,
  stopPayout: noop,
  holdPayout: noop,
  tierHint: noop,
  hotStreak: noop,
  honk: noop,
  womp: noop,
  limitReached: noop,
  kaching: noop,
  subBoom: noop,
  rateLimit: noop,
  motorResume: noop,
  dispose: noop,
};
