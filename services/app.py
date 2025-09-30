import os, json, uuid, io, wave, boto3

MEDIA_BUCKET = os.environ['MEDIA_BUCKET']
JOBS_TABLE = os.environ['JOBS_TABLE']

s3 = boto3.client('s3')
ddb = boto3.resource('dynamodb').Table(JOBS_TABLE)
polly = boto3.client('polly')
bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')

def _put(jobId, fields):
    ddb.update_item(
        Key={'jobId': jobId},
        UpdateExpression="SET " + ", ".join(f"#{k}=:v_{k}" for k in fields),
        ExpressionAttributeNames={f"#{k}": k for k in fields},
        ExpressionAttributeValues={f":v_{k}": v for k, v in fields.items()}
    )

def _bedrock_script(topic: str) -> str:
    # Minimal Claude prompt — adjust later with /prompts content
    prompt = f"""You are a YouTube scriptwriter for retail investors across US/Canada/UK/EU/AU/NZ.
Create a 180–220 second educational script about: "{topic}".
Tone: calm, clear, not promotional. Include "Not financial advice." near the end.
Structure: Hook → 3 key points (each: fact → example → takeaway) → Risks & jurisdiction nuance → CTA.
Use plain language; no bullet lists; keep it conversational.
"""
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 900,
        "temperature": 0.6,
        "messages": [{"role": "user", "content": [{"type":"text","text": prompt}]}]
    }
    model_id = "anthropic.claude-3-5-sonnet-20240620-v1:0"
    resp = bedrock.invoke_model(modelId=model_id, body=json.dumps(body))
    data = json.loads(resp['body'].read())
    text = "".join([b.get("text","") for b in data["content"] if b.get("type")=="text"])
    return text.strip()

def script_handler(evt, _ctx):
    jobId = evt.get('jobId') or str(uuid.uuid4())
    topic = evt.get('topic') or "Global diversification basics"
    script = _bedrock_script(topic)

    s3.put_object(Bucket=MEDIA_BUCKET, Key=f"jobs/{jobId}/script.txt", Body=script.encode('utf-8'))
    _put(jobId, {"status":"SCRIPTED","topic":topic})

    edl = {"fps":30, "audio_s3":f"jobs/{jobId}/voice.wav", "tracks":[]}
    s3.put_object(Bucket=MEDIA_BUCKET, Key=f"jobs/{jobId}/edl.json", Body=json.dumps(edl).encode('utf-8'))
    return {"jobId": jobId, "scriptKey": f"jobs/{jobId}/script.txt"}

def tts_handler(evt, _ctx):
    jobId = evt["jobId"]
    script = s3.get_object(Bucket=MEDIA_BUCKET, Key=f"jobs/{jobId}/script.txt")["Body"].read().decode()

    out = polly.synthesize_speech(Text=script, VoiceId='Matthew', Engine='neural',
                                  OutputFormat='pcm', SampleRate='22050')
    pcm = out['AudioStream'].read()
    buf = io.BytesIO()
    w = wave.open(buf, 'wb')
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050); w.writeframes(pcm); w.close()
    s3.put_object(Bucket=MEDIA_BUCKET, Key=f"jobs/{jobId}/voice.wav", Body=buf.getvalue(), ContentType='audio/wav')
    _put(jobId, {"status":"VO_DONE"})
    return {"jobId": jobId}

def broll_handler(evt, _ctx):
    jobId = evt["jobId"]
    # MVP: use a single default clip you upload later at assets/default_clip.mp4
    edl = json.loads(s3.get_object(Bucket=MEDIA_BUCKET, Key=f"jobs/{jobId}/edl.json")["Body"].read())
    # naive: 30s block
    edl["tracks"] = [{"t":0.0, "dur":30.0, "src_s3":"assets/default_clip.mp4"}]
    s3.put_object(Bucket=MEDIA_BUCKET, Key=f"jobs/{jobId}/edl.json", Body=json.dumps(edl).encode('utf-8'))
    _put(jobId, {"status":"BROLL_DONE"})
    return {"jobId": jobId}

def upload_handler(evt, _ctx):
    jobId = evt["jobId"]
    # MVP: no YouTube upload yet; just mark completed
    # (Optional Step later enables YouTube Data API)
    _put(jobId, {"status":"COMPLETED"})
    return {"jobId": jobId, "note": "final.mp4 is in S3; enable YouTube in optional step."}

def handler(event, context):
    name = os.environ.get('AWS_LAMBDA_FUNCTION_NAME','')
    if name.endswith('scriptFn'): return script_handler(event, context)
    if name.endswith('ttsFn'): return tts_handler(event, context)
    if name.endswith('brollFn'): return broll_handler(event, context)
    if name.endswith('uploadFn'): return upload_handler(event, context)
    return {"error":"no route"}
