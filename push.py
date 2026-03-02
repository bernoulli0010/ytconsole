import subprocess
import os

os.chdir(r'C:\Users\barko\Desktop\ytconsole')

try:
    subprocess.run(['git', 'add', '-A'], check=True)
    subprocess.run(['git', 'commit', '-m', 'feat: Altyazılar sekmesi 8 yeni stil eklendi (classic dark/light, neon blue/pink, comic, minimal, gradient, solid)'], check=True)
    subprocess.run(['git', 'push', 'origin', 'main'], check=True)
    print("Push başarılı!")
except subprocess.CalledProcessError as e:
    print(f"Hata: {e}")
except FileNotFoundError:
    print("Git bulunamadı")
