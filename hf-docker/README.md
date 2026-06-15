---
title: MAPLE Dashboard
emoji: 🍁
colorFrom: red
colorTo: yellow
sdk: docker
app_port: 7860
---

# Maple Dashboard

This is the Hugging Face Docker Space implementation for the Maple Dashboard. It runs the backend on a remote VMOS cloud android device and tunnels the dashboard UI directly into a free Hugging Face Space!

## Setup Instructions

1. Push these files to your Hugging Face Space repository.
2. In your Space's Settings, go to **Variables and secrets**.
3. Create a **New secret** named `ACCESS_KEY` and paste your VMOS Cloud API Access Key.
4. Create another **New secret** named `SECRET_KEY` and paste your VMOS Cloud API Secret Key.

The Space will automatically build the Docker container and start the app on port 7860. Since this Space is private, only you will be able to access the dashboard.

Your fullscreen dashboard view will be at `https://HF_USERNAME-SPACE_NAME.hf.space/` where `HF_USERNAME` is your Hugging Face username & `SPACE_NAME` is your HF space name.
