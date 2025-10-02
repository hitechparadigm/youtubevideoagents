import os
import json
import tempfile
import boto3
from botocore.exceptions import ClientError
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google.oauth2.credentials import Credentials

S3 = boto3.client("s3")
SECRETS = boto3.client("secretsmanager")

MEDIA_BUCKET = os.environ.get("MEDIA_BUCKET")
YT_SECRET_NAME = os.environ.get("YT_SECRET_NAME", "youtube/oauth")

def _load_secret_json(name: str) -> dict:
    resp = SECRETS.get_secret_value(SecretId=name)
    s = resp.get("SecretString") or ""
    # guard against BOM or accidental whitespace
    s = s.lstrip("\ufeff").strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        # Helpful for logs
        prefix = s[:120].replace("\n", "\\n")
        print(f"[ERROR] SecretString not JSON. First 120 chars: '{prefix}'")
        raise

def _youtube_service(secret: dict):
    creds = Credentials(
        token=None,
        refresh_token=secret["refresh_token"],
        client_id=secret["client_id"],
        client_secret=secret["client_secret"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=["https://www.googleapis.com/auth/youtube.upload"]
    )
    return build("youtube", "v3", credentials=creds, cache_discovery=False)

def _s3_download(key: str) -> str:
    fd, path = tempfile.mkstemp(suffix=os.path.splitext(key)[1] or ".mp4")
    os.close(fd)
    S3.download_file(MEDIA_BUCKET, key, path)
    return path

def lambda_handler(event, context):
    print("[EVENT]", json.dumps(event))
    if not MEDIA_BUCKET:
        raise RuntimeError("MEDIA_BUCKET env var is required")

    job_id = (event or {}).get("jobId")
    if not job_id:
        return {"ok": False, "error": "Missing jobId"}

    # metadata (optional) and default title/desc
    meta = {}
    for cand in (f"jobs/{job_id}/meta.json", f"jobs/{job_id}/edl.json"):
        try:
            obj = S3.get_object(Bucket=MEDIA_BUCKET, Key=cand)
            meta = json.loads(obj["Body"].read().decode("utf-8"))
            print("[META] Loaded", cand)
            break
        except ClientError as e:
            if e.response["Error"]["Code"] != "NoSuchKey":
                raise
            print("[META] Not found:", cand)

    title = meta.get("title") or f"Auto Video {job_id}"
    description = meta.get("description") or meta.get("script") or f"Generated video for {job_id}"
    tags = meta.get("tags") or ["auto", "generated"]

    # find video path in S3
    key = meta.get("outputKey") or f"jobs/{job_id}/out.mp4"
    print(f"[YT] Starting upload: title='{title}', key={key}")

    secret = _load_secret_json(YT_SECRET_NAME)
    yt = _youtube_service(secret)

    local = _s3_download(key)
    media = MediaFileUpload(local, chunksize=4 * 1024 * 1024, resumable=True)

    body = {
        "snippet": {"title": title, "description": description, "tags": tags, "categoryId": "24"},  # Entertainment
        "status": {"privacyStatus": meta.get("privacyStatus", "private")}
    }

    request = yt.videos().insert(part="snippet,status", body=body, media_body=media)
    response = None
    while True:
        status, response = request.next_chunk()
        if response is not None:
            break

    vid = response.get("id")
    print(f"[YT] Upload complete. videoId={vid}")
    try:
        os.remove(local)
    except OSError:
        pass

    return {"ok": True, "videoId": vid}
