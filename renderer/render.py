#!/usr/bin/env python3
import os, json, tempfile, subprocess, sys
import boto3
from botocore.exceptions import ClientError

s3 = boto3.client("s3")

def log(msg: str):
    print(msg, flush=True)

def s3_read_json(bucket: str, key: str):
    """Read JSON from S3; tolerate UTF-8 BOM."""
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"].read().decode("utf-8-sig")
    log(f"[EDL] Loaded {len(body)} bytes from {key}")
    return json.loads(body)

def s3_exists(bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as e:
        code = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code == 404 or e.response.get("Error", {}).get("Code") in ("NoSuchKey", "NotFound"):
            return False
        raise

def s3_download(bucket: str, key: str, dst: str):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    s3.download_file(bucket, key, dst)
    log(f"[DL] s3://{bucket}/{key} -> {dst}")

def parse_tracks_edl(edl: dict):
    """
    Minimal EDL schema:
    {
      "audio_key": "voice.wav",
      "tracks": [ { "clips": [ { "s3_key": "broll/default.mp4", "start": 0, "duration": 5 } ] } ]
    }
    """
    if not isinstance(edl, dict):
        raise ValueError("EDL must be a JSON object")
    tracks = edl.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise ValueError("EDL must contain a non-empty 'tracks' array")
    audio_key = edl.get("audio_key", "voice.wav")

    # Flatten the first available clip (keep it simple for now)
    for tr in tracks:
        clips = tr.get("clips") or []
        if clips:
            c = clips[0]
            return audio_key, {
                "s3_key": c["s3_key"],
                "start": float(c.get("start", 0.0)),
                "duration": float(c["duration"]) if c.get("duration") is not None else None,
            }

    raise ValueError("EDL has no clips")

def main():
    # JOB id: prefer env JOB_ID; default to demo placeholder for dev
    job_id = os.environ.get("JOB_ID") or os.environ.get("JOB") or "demo-xxxx"
    bucket = os.environ["MEDIA_BUCKET"]

    # Try new layout first, then legacy
    candidate_keys = [f"jobs/{job_id}/edl.json", f"{job_id}/edl.json"]
    edl = None
    used_key = None
    for k in candidate_keys:
        try:
            log(f"[EDL] Trying s3://{bucket}/{k}")
            edl = s3_read_json(bucket, k)
            used_key = k
            break
        except ClientError as e:
            code = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if code == 404 or e.response.get("Error", {}).get("Code") in ("NoSuchKey", "NotFound"):
                continue
            raise
    if edl is None:
        raise FileNotFoundError(f"Could not find EDL at any of: {candidate_keys}")

    audio_key, clip = parse_tracks_edl(edl)
    log(f"[EDL] Parsed 1 clip; audio_key='{audio_key}'")

    with tempfile.TemporaryDirectory() as tmp:
        # Download the video clip
        video_path = os.path.join(tmp, "clip_000", os.path.basename(clip["s3_key"]))
        s3_download(bucket, clip["s3_key"], video_path)

        # Determine a voice track
        voice_local = os.path.join(tmp, "voice.wav")
        got_voice = False
        for key in (f"jobs/{job_id}/{audio_key}", f"{job_id}/{audio_key}"):
            if s3_exists(bucket, key):
                s3_download(bucket, key, voice_local)
                got_voice = True
                break

        if not got_voice:
            # Generate 1s of silence if voice is missing
            log("[WARN] Voice file not found; generating 1s of silence.")
            subprocess.run(
                ["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                 "-t", "1", "-c:a", "pcm_s16le", voice_local],
                stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, check=True
            )

        # Build ffmpeg args (inputs FIRST, filters/maps AFTER)
        start = clip["start"] or 0.0
        duration = clip["duration"]  # may be None

        # Filter: trim + reset PTS for video
        # If no duration given, let the video run; otherwise set end = start+duration
        filter_video = f"[0:v]trim=start={start}" + (f":end={start + duration}" if duration is not None else "") + ",setpts=PTS-STARTPTS[vout]"

        out_path = os.path.join(tmp, "out.mp4")

        cmd = [
            "ffmpeg", "-y",
            "-i", video_path,      # input #0 (video)
            "-i", voice_local,     # input #1 (audio)
            "-filter_complex", filter_video,
            "-map", "[vout]",      # mapped filtered video
            "-map", "1:a:0",       # mapped audio from input #1
            "-shortest",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-c:a", "aac", "-b:a", "192k",
            out_path,
        ]

        log("[ffmpeg] " + " ".join(cmd))
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        sys.stdout.write(proc.stdout)
        sys.stdout.flush()
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed with exit code {proc.returncode}")

        # Upload result next to the EDL under jobs/<job_id>/out.mp4
        out_key = f"jobs/{job_id}/out.mp4"
        log(f"[UPLOAD] s3://{bucket}/{out_key}")
        s3.upload_file(out_path, bucket, out_key, ExtraArgs={"ContentType": "video/mp4"})
        log("[DONE] Render complete.")

if __name__ == "__main__":
    main()
