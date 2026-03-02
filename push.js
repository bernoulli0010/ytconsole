const { execSync } = require('child_process');
try {
  execSync('git add -A', { cwd: 'C:/Users/barko/Desktop/ytconsole', stdio: 'inherit' });
  execSync('git commit -m "feat: Altyazılar sekmesi 8 yeni stil eklendi (classic dark/light, neon blue/pink, comic, minimal, gradient, solid)"', { cwd: 'C:/Users/barko/Desktop/ytconsole', stdio: 'inherit' });
  execSync('git push origin main', { cwd: 'C:/Users/barko/Desktop/ytconsole', stdio: 'inherit' });
  console.log('Push başarılı!');
} catch (e) {
  console.error('Hata:', e.message);
}
