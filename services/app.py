import os
import io
import json
import re
import wave
import contextlib
import boto3
from botocore.exceptions import ClientError

# Environment
MEDIA_BUCKET = os.environ.get("MEDIA_BUCKET")
JOBS_TABLE   = os.environ.get("JOBS_TABLE")

# Bedrock / Polly clients (created once)
bedrock = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))
polly   = boto3.client("polly")
s3      = boto3.client("s3")
ddb     = boto3.resource("dynamodb").Table(JOBS_TABLE) if JOBS_TABLE else None

# -------- Utilities --------

def _s3_put_text(bucket: str, key: str, text: str):
    s3.put_object(Bucket=bucket, Key=key, Body=text.encode("utf-8"), ContentType="text/plain; charset=utf-8")

def _s3_get_text(bucket: str, key: str) -> str:
    obj = s3.get_object(Bucket=bucket, Key=key)
    return obj["Body"].read().decode("utf-8")

def _safe_key(*parts) -> str:
    # join paths with forward slashes and remove any accidental leading slashes
    return "/".join(str(p).strip("/\\") for p in parts if p is not None)

# --- Sentence-aware chunking for Polly (max ~3000 chars hard limit) ---
# We keep chunks <= 2500 characters with sentence boundaries when possible.
_SENTENCE_SPLIT = re.compile(r"(?<=[\.\!\?])\s+")

def _chunk_text_for_polly(text: str, max_len: int = 2500):
    sentences = _SENTENCE_SPLIT.split(text.strip())
    chunks, cur = [], ""
    for sent in sentences:
        if not sent:
            continue
        # If any single sentence is over max_len, hard-split it.
        if len(sent) > max_len:
            start = 0
            while start < len(sent):
                end = min(start + max_len, len(sent))
                chunks.append(sent[start:end])
                start = end
            continue
        # Greedy pack sentences until we approach max_len
        if len(cur) + len(sent) + 1 <= max_len:
            cur = f"{cur} {sent}".strip()
        else:
            if cur:
                chunks.append(cur)
            cur = sent
    if cur:
        chunks.append(cur)
    return chunks

def _synthesize_chunk_pcm(text: str, voice: str = "Matthew", engine: str = "neural",
                          sample_rate: str = "16000") -> bytes:
    """
    Use PCM output for simple concatenation. Returns raw PCM (16-bit signed little-endian) bytes.
    """
    resp = polly.synthesize_speech(
        Text=text,
        VoiceId=voice,
        Engine=engine,
        OutputFormat="pcm",
        SampleRate=sample_rate
    )
    audio_stream = resp.get("AudioStream")
    return audio_stream.read() if audio_stream else b""

def _write_wav_from_pcm_bytes(out_fp, pcm_bytes: bytes, sample_rate: int = 16000, channels: int = 1, sampwidth: int = 2):
    """
    Write a mono WAV from raw PCM bytes.
    """
    with contextlib.closing(wave.open(out_fp, "wb")) as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sampwidth)  # 16-bit = 2 bytes
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)

# -------- Handlers --------

def script_handler(event, context):
    """
    Generates a script and saves to s3://MEDIA_BUCKET/jobs/{jobId}/script.txt
    Uses Bedrock Claude 3.5 Sonnet (update model_id if you use another).
    """
    job_id = event["jobId"]
    topic  = event["topic"]
    model_id = "anthropic.claude-3-5-sonnet-20240620-v1:0"

    prompt = (
        f"You are a finance YouTube scriptwriter. Write a concise 60–120s voiceover script "
        f"on the topic:\n\n'{topic}'\n\n"
        f"Audience: retail investors in the US, Canada, UK, EU, Australia, and New Zealand. "
        f"Tone: clear, neutral, practical. Avoid advice claims; add a brief risk disclaimer. "
        f"Return plain text only."
    )

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 800,
        "temperature": 0.7,
        "messages": [
            {"role": "user", "content": prompt}
        ]
    }

    resp = bedrock.invoke_model(modelId=model_id, body=json.dumps(body))
    payload = json.loads(resp["body"].read())
    # Claude response format: {"content":[{"type":"text","text":"..."}], ...}
    parts = payload.get("content", [])
    text  = ""
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "text":
            text += part.get("text", "")
    text = text.strip()

    key = _safe_key("jobs", job_id, "script.txt")
    _s3_put_text(MEDIA_BUCKET, key, text)

    if ddb:
        ddb.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET #st=:s, scriptKey=:k",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":s": "SCRIPT_DONE", ":k": key},
        )

    return {"ok": True, "scriptKey": key, "chars": len(text)}


def tts_handler(event, context):
    """
    Reads script.txt, chunks it for Polly if too long, synthesizes PCM chunks,
    concatenates them into a single WAV, and saves voice.wav to the job folder.
    """
    job_id = event["jobId"]
    key_in = _safe_key("jobs", job_id, "script.txt")
    script = _s3_get_text(MEDIA_BUCKET, key_in)

    # Chunk safely for Polly
    chunks = _chunk_text_for_polly(script, max_len=2500)

    # Synthesize each chunk as PCM (16kHz mono)
    pcm_all = bytearray()
    for idx, chunk in enumerate(chunks, 1):
        try:
            pcm = _synthesize_chunk_pcm(chunk, voice=os.environ.get("TTS_VOICE", "Matthew"),
                                        engine=os.environ.get("TTS_ENGINE", "neural"),
                                        sample_rate=os.environ.get("TTS_SAMPLE_RATE", "16000"))
            pcm_all.extend(pcm)
        except ClientError as e:
            # Surface a clean error to the state machine
            raise RuntimeError(f"Polly synth failed on chunk {idx}/{len(chunks)}: {e}")

    # Write WAV to /tmp then upload
    out_local = f"/tmp/{job_id}_voice.wav"
    with open(out_local, "wb") as f:
        _write_wav_from_pcm_bytes(f, bytes(pcm_all),
                                  sample_rate=int(os.environ.get("TTS_SAMPLE_RATE", "16000")),
                                  channels=1, sampwidth=2)

    key_out = _safe_key("jobs", job_id, "voice.wav")
    with open(out_local, "rb") as f:
        s3.put_object(Bucket=MEDIA_BUCKET, Key=key_out, Body=f, ContentType="audio/wav")

    if ddb:
        ddb.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET #st=:s, voiceKey=:k",
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={":s": "TTS_DONE", ":k": key_out},
        )

    return {"ok": True, "voiceKey": key_out, "chunks": len(chunks)}


def broll_handler(event, context):
    """
    Minimal EDL generator (keeps your earlier logic if you had one).
    Writes jobs/{jobId}/edl.json.
    """
    job_id = event["jobId"]
    # Use a default asset; your renderer will loop/trim as needed.
    edl = {
        "fps": 30,
        "clips": [
            {"src": "s3://{}/assets/default_clip.mp4".format(MEDIA_BUCKET), "start": 0, "dur": 15}
        ],
        "audio": "s3://{}/jobs/{}/voice.wav".format(MEDIA_BUCKET, job_id)
    }
    key = _safe_key("jobs", job_id, "edl.json")
    s3.put_object(Bucket=MEDIA_BUCKET, Key=key, Body=json.dumps(edl).encode("utf-8"), ContentType="application/json")
    return {"ok": True, "edlKey": key}


def upload_handler(event, context):
    """
    Stub: keep your existing YouTube uploader if you already built one.
    Here we just confirm output locations for the pipeline to complete.
    """
    job_id = event["jobId"]
    out = {
        "finalVideo": f"s3://{MEDIA_BUCKET}/jobs/{job_id}/final.mp4"
    }
    return {"ok": True, **out}


def handler(event, context):
    """
    Single entry point — dispatch on Lambda function name suffix.
    """
    name = context.function_name
    if name.endswith("scriptFn"):
        return script_handler(event, context)
    if name.endswith("ttsFn"):
        return tts_handler(event, context)
    if name.endswith("brollFn"):
        return broll_handler(event, context)
    if name.endswith("uploadFn"):
        return upload_handler(event, context)
    return {"ok": False, "error": f"Unknown function for handler dispatch: {name}"}
