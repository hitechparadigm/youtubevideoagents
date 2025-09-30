import os, json, boto3, uuid
from moviepy.editor import VideoFileClip, AudioFileClip, concatenate_videoclips

s3 = boto3.client('s3')
bucket = os.environ['MEDIA_BUCKET']
job_id = os.getenv('JOB_ID', str(uuid.uuid4()))

def download(key, path):
    s3.download_file(bucket, key, path)

def upload(path, key):
    s3.upload_file(path, bucket, key, ExtraArgs={"ContentType":"video/mp4"})

def main():
    os.makedirs("/tmp/work", exist_ok=True)
    edl_key = f"jobs/{job_id}/edl.json"
    edl_path = "/tmp/work/edl.json"
    download(edl_key, edl_path)
    edl = json.load(open(edl_path))

    clips=[]
    for tr in edl["tracks"]:
        src_key = tr["src_s3"]
        local = f"/tmp/work/{os.path.basename(src_key)}"
        download(src_key, local)
        clip = VideoFileClip(local).subclip(0, tr["dur"]).set_start(tr["t"])
        clips.append(clip)

    bg = concatenate_videoclips(clips, method="compose")
    voice_local = "/tmp/work/voice.wav"
    download(edl["audio_s3"], voice_local)
    voice = AudioFileClip(voice_local)

    final = bg.set_audio(voice)
    out_local = "/tmp/work/final.mp4"
    final.write_videofile(out_local, fps=edl.get("fps", 30), codec="libx264", audio_codec="aac")
    upload(out_local, f"jobs/{job_id}/final.mp4")

if __name__ == "__main__":
    main()
