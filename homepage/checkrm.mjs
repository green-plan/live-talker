import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto('http://localhost:4324/', { waitUntil: 'networkidle' });
const anim = await page.evaluate(() => {
  const el = document.querySelector('#top .beat-ring');
  return getComputedStyle(el).animationName;
});
console.log('with reduced motion forced ON, animationName =', anim);
await browser.close();
