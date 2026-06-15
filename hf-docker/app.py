import pexpect
import sys
import time
import json
import urllib.request
import urllib.error
import hashlib
import os
import subprocess
import re

ACCESS_KEY = os.environ.get("ACCESS_KEY")
SECRET_KEY = os.environ.get("SECRET_KEY")

if not ACCESS_KEY or not SECRET_KEY:
    print("Missing ACCESS_KEY or SECRET_KEY.")
    sys.exit(1)

def generate_signature(secret_key, timestamp, full_path, payload):
    signature_string = secret_key + timestamp + full_path + (payload or "")
    return hashlib.sha256(signature_string.encode('utf-8')).hexdigest().lower()

def execute_api_request(api_path, payload_object):
    base_url = "https://api.vmoscloud.com"
    context_path = "/vcpcloud/api"
    full_path = context_path + api_path
    
    payload_string = json.dumps(payload_object, separators=(',', ':')) if payload_object is not None else "{}"
    timestamp = str(int(time.time()))
    signature = generate_signature(SECRET_KEY, timestamp, full_path, payload_string)
    
    url = base_url + full_path
    headers = {
        "Content-Type": "application/json",
        "X-Access-Key": ACCESS_KEY,
        "X-Timestamp": timestamp,
        "X-Sign": signature
    }
    
    request = urllib.request.Request(url, data=payload_string.encode('utf-8'), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception as error:
        print(f"Request Error: {error}")
        return None

def main():
    subprocess.run(["adb", "start-server"])

    while True:
        device_list_response = execute_api_request("/padApi/userPadList", {"rows": 10})
        if not device_list_response or device_list_response.get("code") != 200 or not device_list_response.get("data") or len(device_list_response["data"]) == 0:
            print("Cloud device fetch failed.")
            time.sleep(10)
            continue
            
        device_code = device_list_response["data"][0]["padCode"]
        
        adb_response = execute_api_request("/padApi/adb", {"padCode": device_code, "enable": True})
        if not adb_response or adb_response.get("code") != 200 or not adb_response.get("data"):
            print("ADB fetch failed.")
            time.sleep(10)
            continue
            
        adb_data = adb_response["data"]
        ssh_command = adb_data["command"]
        ssh_password = adb_data["key"]
        
        port_match = re.search(r'-L\s+(\d+):localhost:1', ssh_command)
        if not port_match:
            print("Port match failed.")
            time.sleep(10)
            continue
            
        adb_port = port_match.group(1)
        
        ssh_process = pexpect.spawn(ssh_command, encoding='utf-8')
        ssh_process.logfile_read = sys.stdout
        prompt_index = ssh_process.expect(['(?i)password:', pexpect.EOF, pexpect.TIMEOUT], timeout=15)
        
        if prompt_index == 0:
            ssh_process.sendline(ssh_password)
            
            ssh_process.expect(pexpect.EOF)
            
            is_connected = False
            for attempt_index in range(15):
                adb_process = subprocess.run(["adb", "connect", f"localhost:{adb_port}"], capture_output=True, text=True)
                adb_output = adb_process.stdout.lower() + adb_process.stderr.lower()
                if "connected to localhost" in adb_output or "already connected" in adb_output:
                    is_connected = True
                    break
                time.sleep(1)
                
            if not is_connected:
                print("Connection failed.")
                subprocess.run(["pkill", "-f", f"localhost:{adb_port}"])
                time.sleep(5)
                continue
                
            print("Connected.")
            subprocess.run(["adb", "-s", f"localhost:{adb_port}", "forward", "tcp:3000", "tcp:3000"])
            
            proxy_process = subprocess.Popen(["socat", "tcp-listen:7860,fork,reuseaddr", "tcp:127.0.0.1:3000"])
            
            try:
                while True:
                    dev_res = subprocess.run(["adb", "devices"], capture_output=True, text=True)
                    if f"localhost:{adb_port}\toffline" in dev_res.stdout or f"localhost:{adb_port}" not in dev_res.stdout:
                        print("Disconnected.")
                        break
                    if proxy_process.poll() is not None:
                        print("Disconnected.")
                        break
                    time.sleep(5)
            except KeyboardInterrupt:
                proxy_process.terminate()
                proxy_process.wait()
                subprocess.run(["adb", "disconnect", f"localhost:{adb_port}"], capture_output=True)
                subprocess.run(["adb", "forward", "--remove", "tcp:3000"], capture_output=True)
                subprocess.run(["pkill", "-f", f"localhost:{adb_port}"])
                sys.exit(0)
                
            proxy_process.terminate()
            proxy_process.wait()
            subprocess.run(["adb", "disconnect", f"localhost:{adb_port}"], capture_output=True)
            subprocess.run(["adb", "forward", "--remove", "tcp:3000"], capture_output=True)
            subprocess.run(["pkill", "-f", f"localhost:{adb_port}"])
            time.sleep(5)
                
        else:
            print("Timeout.")
            subprocess.run(["pkill", "-f", f"localhost:{adb_port}"])
            time.sleep(10)

if __name__ == "__main__":
    main()
