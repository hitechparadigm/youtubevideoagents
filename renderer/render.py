#!/usr/bin/env python3
import json
import os
import sys
import tempfile
import subprocess
from pathlib import Path
import boto3
from botocore.exceptions import ClientError, NoCredentialsError

S3 = boto3.client("s3")


def log(msg: str):
    print(msg, flush=True)


def env_or_die(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        log(f"[FATAL] Missing environment variable: {name}")
        sys.exit(1)
    return val


def s3_get_text(bucket: str, key: str) -> str:
    try:
        obj = S3.get_object(Bucket=bucket, Key=key)
        return obj["Body"].read().decode("utf-8")
    except S3.exceptions.NoSuchKey:
        raise FileNotFoundError(f"s3://{bucket}/{key} not found")
    except ClientError as e:
        raise RuntimeError(f"Failed to read s3://{bucket}/{key}: {e}")


def s3_download(bucket: str, key: str, to_path: Path):
    to_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        S3.download_file(bucket, key, str(to_path))
    except ClientError as e:
        raise RuntimeError(f"Failed to download s3://{bucket}/{key}: {e}")


def s3_upload(bucket: str, key: str, from_path: Path):
    try:
        S3.upload_file(str(from_path), bucket, key)
    except ClientError as e:
        raise RuntimeError(f"Failed to upload to s3://{bucket}/{key}: {e}")


def load_edl(bucket: str, job_id: str) -> dict:
    # Preferred path first
    candidates = [
        f"jobs/{job_id}/edl.json",
        f"{job_id}/edl.json",
    ]
    last_err = None
    for key in candidates:
        try:
            log(f"[EDL] Trying s3://{bucket}/{key}")
            txt = s3_get_text(bucket, key)
            log(f"[EDL] Loaded {len(txt)} bytes from {key}")
            edl = json.loads(txt)
            edl["_edl_key"] = key
            return edl
        except Exception as e:
            last_err = e
            log(f"[EDL] {e}")
    raise RuntimeError(f"Unable to load EDL from any known location: {last_err}")


def normalize_edl(edl: dict) -> dict:
    """
    Accept either of these shapes:
    A) Nested:
       {
         "audio_key": "voice.wav",
         "tracks": [
           { "clips": [ { "s3_key": "broll/default.mp4", "start": 0, "duration": 5 }, ... ] }
         ]
       }
    B) Flat (legacy):
       {
         "audio_key": "voice.wav",
         "tracks": [
           { "s3_key": "broll/default.mp4", "start": 0, "duration": 5 }
         ]
       }
    """
    if "tracks" not in edl or not isinstance(edl["tracks"], list) or len(edl["tracks"]) == 0:
        raise ValueError("EDL must contain a non-empty 'tracks' array")

    tracks = edl["tracks"]
    flat_clips = []

    # Case A: tracks[].clips[]
    if isinstance(tracks[0], dict) and "clips" in tracks[0]:
        for ti, tr in enumerate(tracks):
            if "clips" not in tr or not isinstance(tr["clips"], list):
                raise ValueError(f"EDL track {ti} has no 'clips' array")
            for ci, clip in enumerate(tr["clips"]):
                flat_clips.append(_validate_clip(clip, hint=f"tracks[{ti}].clips[{ci}]"))
    else:
        # Case B: tracks[] contains clip objects directly
        for ci, clip in enumerate(tracks):
            flat_clips.append(_validate_clip(clip, hint=f"tracks[{ci}]"))

    audio_key = edl.get("audio_key")  # optional but recommended
    return {"audio_key": audio_key, "clips": flat_clips}


def _validate_clip(clip: dict, hint: str) -> dict:
    if not isinstance(clip, dict):
        raise ValueError(f"EDL {hint} must be an object")
    # Accept either s3_key or src_s3 for compatibility
    s3_key = clip.get("s3_key") or clip.get("src_s3")
    if not s3_key:
        raise ValueError(f"EDL {hint} missing 's3_key' (or legacy 'src_s3')")
    start = float(clip.get("start", 0))
    dur = clip.get("duration", None)
    duration = None if dur is None else float(dur)
    if duration is not None and duration < 0:
        raise ValueError(f"EDL {hint} 'duration' must be >= 0")
    return {"s3_key": s3_key, "start": start, "duration": duration}


def build_ffmpeg_concat(tmp: Path, inputs: list[Path], trims: list[tuple[float, float | None]]) -> Path:
    """
    Create a concat filter that trims each input clip by [start, start+duration]
    and concatenates video+audio (source audio from the clips is dropped; we’ll
    overlay a separate voice track if provided).
    """
    # For simplicity, we’ll only use the video stream from the clips and
    # ignore clip audio (many B-rolls don’t have audio or we don’t want it).
    # Each input becomes: [i:v]trim=start:end,setpts=PTS-STARTPTS[v{i}]
    # Then concat all [v{i}] -> [vout]
    filters = []
    vlabels = []
    for i, (_in, (start, duration)) in enumerate(zip(inputs, trims)):
        # Input is added with -i later; reference as {i}:v
        if duration is None:
            filt = f"[{i}:v]trim=start={start},setpts=PTS-STARTPTS[v{i}]"
        else:
            end = start + duration
            filt = f"[{i}:v]trim=start={start}:end={end},setpts=PTS-STARTPTS[v{i}]"
        filters.append(filt)
        vlabels.append(f"[v{i}]")

    filters.append(f"{''.join(vlabels)}concat=n={len(vlabels)}:v=1:a=0[vout]")
    filter_complex = ";".join(filters)

    concat_list = tmp / "concat.txt"  # not used by filter pipeline, but helpful when debugging
    concat_list.write_text("\n".join(str(p) for p in inputs), encoding="utf-8")

    return filter_complex


def run_ffmpeg(cmd: list[str]):
    log(f"[ffmpeg] {' '.join(cmd)}")
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    log(proc.stdout)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed with exit code {proc.returncode}")


def render(bucket: str, job_id: str, edl: dict):
    norm = normalize_edl(edl)
    clips = norm["clips"]
    audio_key = norm["audio_key"]

    if not clips:
        raise ValueError("EDL contains zero clips after normalization")

    log(f"[EDL] Parsed {len(clips)} clip(s); audio_key={audio_key!r}")

    with tempfile.TemporaryDirectory() as tdir:
        tdir = Path(tdir)
        # Download all clips
        input_paths = []
        trims = []
        for idx, c in enumerate(clips):
            src_key = c["s3_key"]
            local = tdir / f"clip_{idx:03d}" / Path(src_key).name
            log(f"[DL] b-roll s3://{bucket}/{src_key} -> {local}")
            s3_download(bucket, src_key, local)
            input_paths.append(local)
            trims.append((c["start"], c["duration"]))

        # Optional voice track
        voice_path = None
        if audio_key:
            voice_path = tdir / "voice.wav"
            try:
                log(f"[DL] voice s3://{bucket}/{job_id}/{audio_key} -> {voice_path}")
                s3_download(bucket, f"{job_id}/{audio_key}", voice_path)
            except Exception as e:
                log(f"[WARN] Could not fetch voice from {job_id}/; trying jobs/{job_id}/")
                try:
                    s3_download(bucket, f"jobs/{job_id}/{audio_key}", voice_path)
                except Exception as e2:
                    log(f"[WARN] No voice track found ({e2}); proceeding silent.")
                    voice_path = None

        # Build filters
        fc = build_ffmpeg_concat(Path(tdir), input_paths, trims)

        # Assemble ffmpeg command
        cmd = ["ffmpeg", "-y"]
        for p in input_paths:
            cmd += ["-i", str(p)]

        # Filter to concat videos -> [vout]
        cmd += ["-filter_complex", fc, "-map", "[vout]"]

        # Add voice as main audio if present, else create silent audio
        if voice_path and voice_path.exists():
            cmd += ["-i", str(voice_path), "-map", f"{len(input_paths)}:a:0", "-shortest"]
        else:
            # generate silent audio matching the video duration
            cmd += [
                "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
                "-map", "1:a", "-shortest"
            ]

        out_path = Path(tdir) / "out.mp4"
        # Reasonable baseline encoding
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "192k", str(out_path)]

        run_ffmpeg(cmd)

        # Upload result
        out_key = f"jobs/{job_id}/out.mp4"
        log(f"[UP] Uploading rendered video to s3://{bucket}/{out_key}")
        s3_upload(bucket, out_key, out_path)

        # Write a tiny marker json
        marker = Path(tdir) / "render_done.json"
        marker.write_text(json.dumps({"jobId": job_id, "edl": edl.get('_edl_key'), "output": out_key}), encoding="utf-8")
        s3_upload(bucket, f"jobs/{job_id}/render_done.json", marker)

    log("[OK] Rendering complete.")


def main():
    bucket = env_or_die("MEDIA_BUCKET")
    job_id = os.environ.get("JOB_ID") or os.environ.get("jobId")
    if not job_id:
        log("[FATAL] JOB_ID not provided to container (ECS env var).")
        sys.exit(1)

    try:
        edl = load_edl(bucket, job_id)
        render(bucket, job_id, edl)
    except (NoCredentialsError, ClientError) as e:
        log(f"[FATAL] AWS error: {e}")
        sys.exit(2)
    except Exception as e:
        log(f"[FATAL] {type(e).__name__}: {e}")
        sys.exit(3)


if __name__ == "__main__":
    main()
