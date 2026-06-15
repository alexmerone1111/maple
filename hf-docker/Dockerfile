FROM python:3.9-slim

RUN apt-get update && apt-get install -y \
    android-tools-adb \
    openssh-client \
    socat \
    && rm -rf /var/lib/apt/lists/*

RUN pip install pexpect

WORKDIR /app
COPY . .

CMD ["python", "-u", "app.py"]
