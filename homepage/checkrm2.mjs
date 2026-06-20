import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto('http://localhost:4324/', { waitUntil: 'networkidle' });
for (let i = 0; i < 6; i++) {
  const v = await page.evaluate(() => getComputedStyle(document.querySelector('#top .beat-ring')).boxShadow);
  console.log(i*150, 'ms:', v);
  await page.waitForTimeout(150);
}
await browser.close();
