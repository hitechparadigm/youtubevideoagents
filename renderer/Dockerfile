# Pin to Debian bookworm (stable) to avoid trixie apt flakiness
FROM python:3.12-bookworm

# Faster, more reliable apt install for ffmpeg
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN python -m pip install --upgrade pip \
 && pip install -r requirements.txt

COPY render.py ./
# (Optional) avoid matplotlib writing to a read-only home
ENV MPLCONFIGDIR=/tmp/mpl

ENTRYPOINT ["python", "render.py"]
