#!/usr/bin/env python3
"""MIDI -> Arduino tone() arrays for the 3-pin buzzer sketches.

    python3 midi2tone.py song.mid                 # print melody[]/duration[]
    python3 midi2tone.py song.mid --bpm 200 --max 120
    python3 midi2tone.py --selftest               # no file needed

A buzzer plays ONE note at a time, so a polyphonic file has to be flattened:
at every instant this keeps the highest-pitched sounding note, which is where
the melody usually lives. Chords, bass lines and inner voices are discarded.
That is the whole reason a busy track never sounds like the recording.

Deps: mido (pip3 install mido). No audio decoding here — MIDI is already notes,
which is why it beats pitch-tracking an mp3.
"""
import sys, argparse

A4_MIDI, A4_HZ = 69, 440.0


def hz(note):
    return round(A4_HZ * 2 ** ((note - A4_MIDI) / 12.0))


def list_tracks(path):
    import mido
    mid = mido.MidiFile(path)
    print(f"{path}  {len(mid.tracks)} tracks, {mid.length:.0f}s")
    for i, tr in enumerate(mid.tracks):
        ns = [m.note for m in tr if m.type == 'note_on' and m.velocity > 0]
        ch = {m.channel for m in tr if hasattr(m, 'channel')}
        if not ns:
            continue
        drum = ' DRUMS(skipped)' if 9 in ch else ''
        span = _span(mid, i)
        print(f"  {i:2d}: {len(ns):5d} notes  range {min(ns):3d}-{max(ns):3d}  "
              f"plays {span[0]:5.0f}-{span[1]:5.0f}s  {tr.name!r}{drum}")


def _span(mid, idx):
    """(first_note_s, last_note_s) for one track — which section it belongs to."""
    import mido
    t, tempo, times = 0.0, 500000, []
    for msg in mid.tracks[idx]:
        t += mido.tick2second(msg.time, mid.ticks_per_beat, tempo)
        if msg.type == 'set_tempo':
            tempo = msg.tempo
        if msg.type == 'note_on' and msg.velocity > 0:
            times.append(t)
    return (min(times), max(times)) if times else (0.0, 0.0)


def notes_from(path, keep=None):
    """[(start_s, end_s, midi_note)]. keep = track indices, None = all melodic.

    Channel 9 is General MIDI percussion — its note numbers are drum sounds, not
    pitches, so it is always dropped. A merged multi-track file also mixes lead
    and bass, and the top-voice reduction then jumps between them; --track is
    the fix, not a smarter reducer.
    """
    import mido
    mid = mido.MidiFile(path)
    out, open_notes, t = [], {}, 0.0
    for msg in mid:                       # mido yields delta in seconds here
        t += msg.time
        if getattr(msg, 'channel', None) == 9:
            continue
        if msg.type == 'note_on' and msg.velocity > 0:
            open_notes.setdefault(msg.note, []).append(t)
        elif msg.type in ('note_off', 'note_on'):   # note_on vel 0 = off
            starts = open_notes.get(msg.note)
            if starts:
                out.append((starts.pop(0), t, msg.note))
    if keep is None:
        return sorted(out)
    # mido's merged iteration loses track identity, so re-walk per track.
    out, tempo = [], 500000
    for msg in mido.merge_tracks(mid.tracks):
        pass
    out = []
    for idx in keep:
        t, open_notes, tempo = 0.0, {}, 500000
        for msg in mid.tracks[idx]:
            t += mido.tick2second(msg.time, mid.ticks_per_beat, tempo)
            if msg.type == 'set_tempo':
                tempo = msg.tempo
            if getattr(msg, 'channel', None) == 9:
                continue
            if msg.type == 'note_on' and msg.velocity > 0:
                open_notes.setdefault(msg.note, []).append(t)
            elif msg.type in ('note_off', 'note_on'):
                starts = open_notes.get(msg.note)
                if starts:
                    out.append((starts.pop(0), t, msg.note))
    return sorted(out)


def monophonic(notes):
    """Highest sounding pitch wins. Returns [(start, end, note)], no overlaps."""
    events = sorted({t for n in notes for t in (n[0], n[1])})
    line = []
    for a, b in zip(events, events[1:]):
        if b - a < 1e-4:
            continue
        sounding = [n for n in notes if n[0] <= a + 1e-6 and n[1] >= b - 1e-6]
        top = max((n[2] for n in sounding), default=None)
        if line and line[-1][2] == top and abs(line[-1][1] - a) < 1e-6:
            line[-1] = (line[-1][0], b, top)      # extend, don't restart
        else:
            line.append((a, b, top))
    return line


# ---------------------------------------------------------------- audio input
SR, FRAME, HOP = 22050, 2048, 512
F_MIN, F_MAX = 80.0, 1200.0        # piano melody range; above this it's partials


def _decode(path, t0, dur):
    """mp3/wav -> mono float32 at SR, via ffmpeg. No audio lib needed."""
    import subprocess
    import numpy as np
    cmd = ['ffmpeg', '-v', 'error']
    if t0:
        cmd += ['-ss', str(t0)]
    cmd += ['-i', path]
    if dur:
        cmd += ['-t', str(dur)]
    cmd += ['-f', 'f32le', '-ac', '1', '-ar', str(SR), '-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    return np.frombuffer(raw, dtype='<f4')


def _f0(frame, np):
    """Autocorrelation pitch of one frame, or None. Parabolic-interpolated.

    IMPORTANT NOTE: this finds ONE pitch. Piano is polyphonic, so on a chord it
    reports whichever note dominates the frame — usually but not always the
    melody. That is the accuracy ceiling of the audio path and no threshold
    fixes it; a MIDI of the same piece has the notes already separated.
    """
    w = frame * np.hanning(len(frame))
    if float(np.sqrt(np.mean(w ** 2))) < 0.01:      # silence gate
        return None
    spec = np.fft.rfft(w, n=2 * len(w))
    r = np.fft.irfft(spec * np.conj(spec))[:len(w)]
    if r[0] <= 0:
        return None
    lo, hi = int(SR / F_MAX), min(int(SR / F_MIN), len(r) - 2)
    if hi <= lo:
        return None
    k = lo + int(np.argmax(r[lo:hi]))
    if r[k] / r[0] < 0.3:                            # too noisy to call a pitch
        return None
    a, b, c = r[k - 1], r[k], r[k + 1]               # parabolic refine
    denom = a - 2 * b + c
    shift = 0.5 * (a - c) / denom if denom else 0.0
    # Clamp to +-0.5 bin. A near-zero denominator sends this to thousands, which
    # walks the lag negative and comes back as a NaN frequency — clean sines
    # never trigger it, real audio does within a second.
    k = k + max(-0.5, min(0.5, shift))
    f = SR / k if k > 0 else 0.0
    return f if F_MIN <= f <= F_MAX else None


def audio_notes(path, t0=0.0, dur=0.0, min_ms=60, fmin=None, fmax=None):
    """[(start_s, end_s, midi_note)] pitch-tracked from audio."""
    import numpy as np
    global F_MIN, F_MAX
    if fmin: F_MIN = fmin        # a piano's left hand lives below ~250Hz; raising
    if fmax: F_MAX = fmax        # the floor keeps the tracker on the melody hand
    x = _decode(path, t0, dur)
    pitches = []
    for i in range(0, max(0, len(x) - FRAME), HOP):
        f = _f0(x[i:i + FRAME], np)
        pitches.append(None if f is None
                       else int(round(A4_MIDI + 12 * np.log2(f / A4_HZ))))
    # median-of-3 smoothing: single-frame octave jumps are tracker errors, not notes
    sm = list(pitches)
    for i in range(1, len(pitches) - 1):
        w = [q for q in pitches[i - 1:i + 2] if q is not None]
        sm[i] = int(np.median(w)) if len(w) == 3 else pitches[i]
    out, run_start, cur = [], 0.0, None
    for i, q in enumerate(sm + [None]):
        t = i * HOP / SR
        if q != cur:
            if cur is not None and (t - run_start) * 1000 >= min_ms:
                out.append((run_start, t, cur))
            run_start, cur = t, q
    return out


def window(line, t0, t1):
    """Keep notes inside [t0, t1) and rebase to zero, so a middle section can be
    played without the minutes before it. A note straddling the edge is clipped,
    not dropped — otherwise a long held note at the boundary vanishes."""
    out = []
    for start, end, note in line:
        if end <= t0 or (t1 and start >= t1):
            continue
        out.append((max(start, t0) - t0, (min(end, t1) if t1 else end) - t0, note))
    return out


def quantise(line, bpm, max_notes):
    """-> [(hz_or_0, beats_x2)] on the sketches' half-beat grid."""
    unit = 30.0 / bpm                      # seconds per half-beat
    melody, dur, prev_end = [], [], 0.0
    for start, end, note in line:
        gap = round((start - prev_end) / unit)
        if gap >= 1:
            melody.append(0); dur.append(gap)
        d = max(1, round((end - start) / unit))
        melody.append(hz(note) if note is not None else 0); dur.append(d)
        prev_end = end
        if len(melody) >= max_notes:
            break
    return melody, dur


def emit(melody, dur, bpm, name):
    w = lambda xs: ",\n  ".join(", ".join(f"{v:5d}" for v in xs[i:i + 8])
                               for i in range(0, len(xs), 8))
    return (f"// {name} — {len(melody)} notes, generated by midi2tone.py\n"
            f"const int BPM = {bpm};\n\n"
            f"const int melody[] = {{\n  {w(melody)}\n}};\n"
            f"const int duration[] = {{\n  {w(dur)}\n}};\n"
            f"const int N = sizeof(melody) / sizeof(melody[0]);\n")


def selftest():
    import mido
    mid = mido.MidiFile(); tr = mido.MidiTrack(); mid.tracks.append(tr)
    tpb = mid.ticks_per_beat
    tr.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(120), time=0))
    # C4 for a beat, then a C4+E4 chord for a beat: the chord must reduce to E4.
    for note, on, off in ((60, 0, tpb), (60, 0, 0), (64, 0, tpb)):
        tr.append(mido.Message('note_on', note=note, velocity=64, time=on))
        if off:
            tr.append(mido.Message('note_off', note=note, velocity=0, time=off))
    tr.append(mido.Message('note_off', note=60, velocity=0, time=0))
    tr.append(mido.Message('note_off', note=64, velocity=0, time=tpb))
    path = '/tmp/_m2t_selftest.mid'; mid.save(path)

    assert hz(69) == 440 and hz(81) == 880, "midi->hz octave is wrong"
    mel, dur = quantise(monophonic(notes_from(path)), bpm=120, max_notes=999)
    assert 262 in mel, f"C4 (262Hz) missing: {mel}"
    assert 330 in mel, f"chord did not reduce to its top note E4: {mel}"
    assert all(d >= 1 for d in dur), f"zero-length note: {dur}"
    assert len(mel) == len(dur), "array length mismatch — sketch would overrun"
    # audio path: two synthesised tones must come back as A4 then A5
    import numpy as np, wave, struct
    t = np.arange(int(SR * 0.5)) / SR
    sig = np.concatenate([np.sin(2 * np.pi * 440 * t), np.sin(2 * np.pi * 880 * t)])
    wp = '/tmp/_m2t_selftest.wav'
    with wave.open(wp, 'w') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(SR)
        f.writeframes(struct.pack('<%dh' % len(sig), *(sig * 20000).astype(int)))
    got = [n for _, _, n in audio_notes(wp)]
    assert 69 in got, f"440Hz not heard as A4(69): {got}"
    assert 81 in got, f"880Hz not heard as A5(81): {got}"
    print("audio selftest ok: detected midi notes", sorted(set(got)))

    print("selftest ok:", list(zip(mel, dur)))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('midi', nargs='?')
    p.add_argument('--bpm', type=int, default=160, help='grid tempo, not playback')
    p.add_argument('--max', type=int, default=200,
                   help='note cap; 200 notes is ~1.6KB of flash')
    p.add_argument('--track', type=int, action='append',
                   help='track index to use (repeatable); default = all melodic')
    p.add_argument('--list', action='store_true', help='show tracks and exit')
    p.add_argument('--from', dest='t0', type=float, default=0.0,
                   help='start at this many seconds into the file')
    p.add_argument('--dur', type=float, default=0.0,
                   help='seconds to take from --from (0 = to the end)')
    p.add_argument('--audio', action='store_true',
                   help='input is mp3/wav — pitch-track it instead of reading MIDI')
    p.add_argument('--fmin', type=float, help='Hz floor (audio); 250 skips a piano left hand')
    p.add_argument('--fmax', type=float, help='Hz ceiling (audio)')
    p.add_argument('--selftest', action='store_true')
    a = p.parse_args()
    if a.selftest:
        selftest(); sys.exit()
    if not a.midi:
        p.error('give a .mid file, or --selftest')
    if a.list:
        list_tracks(a.midi); sys.exit()
    if a.audio:
        line = audio_notes(a.midi, a.t0, a.dur, fmin=a.fmin, fmax=a.fmax)
    else:
        line = monophonic(notes_from(a.midi, a.track))
        line = window(line, a.t0, a.t0 + a.dur if a.dur else 0.0)
    mel, dur = quantise(line, a.bpm, a.max)
    print(emit(mel, dur, a.bpm, a.midi.split('/')[-1]), end='')
