from __future__ import annotations

import logging
import os
import re
import shutil
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import soundfile as sf

from .asr import Transcriber
from .audio import finish, ops
from .qa import PASS_SCORE, score
from .repo import Repo
from .settings import JobSettings
from .subs import Cue, to_srt, to_vtt
from .synth import Synthesizer, VoiceRef
from .text.lang import guess_language

log = logging.getLogger("lq_tts_engine.pipeline")

MAX_TAKES = 4
_REV = re.compile(r"^r(\d+)$")


class Canceled(Exception):
    """Cancel was requested while the job was running."""


class SynthesisFailed(Exception):
    """Every take of a sentence was silent."""


def job_dir(data_dir: Path, job_id) -> Path:
    return data_dir / "jobs" / str(job_id)


def revision_dir(data_dir: Path, job_id, revision: int) -> Path:
    return job_dir(data_dir, job_id) / f"r{revision}"


def latest_revision(data_dir: Path, job_id) -> int | None:
    root = job_dir(data_dir, job_id)
    if not root.exists():
        return None
    revisions = [int(m.group(1)) for p in root.iterdir() if p.is_dir() and (m := _REV.match(p.name)) and any(p.iterdir())]
    return max(revisions) if revisions else None


@dataclass
class Deps:
    repo: Repo
    synth: Synthesizer
    asr: Transcriber
    data_dir: Path
    rtf_window: deque = field(default_factory=lambda: deque(maxlen=20))

    def rolling_rtf(self) -> float | None:
        return sum(self.rtf_window) / len(self.rtf_window) if self.rtf_window else None


def process_sentence(job: dict, sentence: dict, voice: dict, deps: Deps, should_stop: Callable[[], bool]) -> None:
    settings = JobSettings(**job["settings"])
    ref = VoiceRef(voice["ref_audio_path"], voice["ref_transcript"])
    language = guess_language(sentence["text"]) or voice.get("language")
    takes_dir = job_dir(deps.data_dir, job["id"]) / "takes"
    takes_dir.mkdir(parents=True, exist_ok=True)
    sr = deps.synth.sample_rate
    best: tuple[float, Path, str, float] | None = None
    take_no = 0
    for take_no in range(1, MAX_TAKES + 1):
        if should_stop():
            raise Canceled()
        started = time.monotonic()
        raw = deps.synth.generate(sentence["text"], ref, sentence["style"])
        if len(raw):
            deps.rtf_window.append((time.monotonic() - started) / (len(raw) / sr))
        try:
            audio = ops.fade(ops.tempo(ops.trim(raw, sr), sr, settings.speed), sr)
        except ops.SilentAudio:
            continue
        path = takes_dir / f"s{sentence['idx']:04d}_r{job['revision']}_t{take_no}.wav"
        sf.write(path, audio, sr, subtype="FLOAT")
        heard = " ".join(w.text for w in deps.asr.transcribe(path, language).words)
        take_score = score(sentence["text"], heard)
        if best is None or take_score > best[0]:
            best = (take_score, path, heard, len(audio) / sr)
        if take_score >= PASS_SCORE:
            break
    if best is None:
        raise SynthesisFailed(f"sentence {sentence['idx']}: every take was silent")
    take_score, path, heard, duration = best
    status = "done" if take_score >= PASS_SCORE else "needs_review"
    deps.repo.save_sentence(
        job["id"], sentence["idx"], status=status,
        takes=take_no, score=take_score, asr_text=heard, audio_path=str(path), duration_s=duration,
    )
    log.info("sentence done", extra={"ctx": {"job": str(job["id"]), "revision": job["revision"],
                                             "idx": sentence["idx"], "status": status, "takes": take_no,
                                             "score": round(take_score, 3), "duration_s": round(duration, 3)}})


def assemble_revision(job: dict, deps: Deps) -> float:
    settings = JobSettings(**job["settings"])
    sentences = deps.repo.list_sentences(job["id"])
    sr = deps.synth.sample_rate
    segments, gaps = [], []
    for i, s in enumerate(sentences):
        audio, file_sr = sf.read(s["audio_path"], dtype="float32")
        if file_sr != sr:
            raise RuntimeError(f"take {s['audio_path']} is {file_sr} Hz, expected {sr}")
        segments.append(audio)
        if i < len(sentences) - 1:
            new_paragraph = sentences[i + 1]["paragraph_idx"] != s["paragraph_idx"]
            gaps.append(settings.pause_paragraph_s if new_paragraph else settings.pause_sentence_s)
    audio, times = ops.assemble(segments, gaps, sr)

    out = revision_dir(deps.data_dir, job["id"], job["revision"])
    staging = out.with_name(out.name + ".tmp")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    raw = staging / "raw.wav"
    sf.write(raw, audio, sr, subtype="FLOAT")
    final_wav = staging / "final.wav"
    finish.loudnorm(raw, final_wav, settings.loudness_lufs, sr=sr)
    raw.unlink()
    if "mp3" in settings.formats:
        finish.encode_mp3(final_wav, staging / "final.mp3", sr=sr)
    cues = [Cue(a, b, s["text"]) for s, (a, b) in zip(sentences, times)]
    if "srt" in settings.formats:
        (staging / "subs.srt").write_text(to_srt(cues), encoding="utf-8")
    if "vtt" in settings.formats:
        (staging / "subs.vtt").write_text(to_vtt(cues), encoding="utf-8")
    if "wav" not in settings.formats:
        final_wav.unlink()
    if out.exists():
        shutil.rmtree(out)
    os.replace(staging, out)
    deps.repo.set_sentence_times(job["id"], [(s["idx"], a, b) for s, (a, b) in zip(sentences, times)])
    return len(audio) / sr


def run_job(job: dict, deps: Deps, *, should_stop: Callable[[], bool]) -> str:
    voice = deps.repo.get_voice_any(job["voice_id"])
    if voice is None or voice["status"] != "ready" or voice["deleted_at"] is not None:
        deps.repo.fail_job(job["id"], "voice_not_ready")
        return "failed"
    try:
        while True:
            if should_stop():
                raise Canceled()
            sentence = deps.repo.next_pending_sentence(job["id"])
            if sentence is None:
                break
            deps.repo.mark_sentence_running(job["id"], sentence["idx"])
            try:
                process_sentence(job, sentence, voice, deps, should_stop)
            except Canceled:
                deps.repo.save_sentence(job["id"], sentence["idx"], status="pending", takes=0, score=None,
                                        asr_text=None, audio_path=sentence["audio_path"], duration_s=sentence["duration_s"])
                raise
    except Canceled:
        return "canceled"
    seconds = assemble_revision(job, deps)
    deps.repo.finish_job(job["id"], seconds)
    return "done"
