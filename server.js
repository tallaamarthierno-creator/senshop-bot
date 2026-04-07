import express from 'express';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

const app = express();
app.use(express.json());

const API_SECRET = process.env.RAILWAY_API_SECRET;

app.use((req, res, next) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.post('/scrape-product', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  let browser;
  try {
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 8000));

    const data = await page.evaluate(() => {
      // Méthode 1 : window.runParams
      try {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          const text = s.textContent;
          if (text.includes('window.runParams')) {
            const match = text.match(/window\.runParams\s*=\s*(\{[\s\S]+?\});/);
            if (match) {
              const json = JSON.parse(match[1]);
              const d = json?.data;
              const title = d?.titleModule?.subject;
              const price = d?.priceModule?.minAmount?.value
                         || d?.priceModule?.minPrice?.value;
              const images = d?.imageModule?.imagePathList;
              if (title) return {
                name: title,
                price_usd: price ? parseFloat(String(price).replace(/[^\d.]/g, '')) || null : null,
                image_url: images?.[0] ? `https:${images[0]}` : null
              };
            }
          }
        }
      } catch(e) {}

      // Méthode 2 : meta tags
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
      const ogImage = document.querySelector('meta[property="og:image"]')?.content;

      // Méthode 3 : DOM fallback
      const h1 = document.querySelector('h1');
 const img = document.querySelector('img[src*="alicdn"]');

 const priceSelectors = [
   '[class*="price--current"]',
   '[class*="uniform-banner-box-price"]',
   '[class*="product-price-value"]',
   '[class*="manhattan--price-sale"]',
   '[class*="price-sale"]',
   'span[data-role="sale-price"]',
   '.product-price-current',
   '[class*="SnowPrice"]',
 ];

 let priceEl = null;
 for (const sel of priceSelectors) {
   const el = document.querySelector(sel);
   if (el && el.textContent.match(/\d/)) {
     priceEl = el;
     break;
   }
 }

 return {
   name: ogTitle || h1?.textContent?.trim() || null,
   price_usd: priceEl ? parseFloat(priceEl.textContent.replace(/[^\d.]/g, '')) || null : null,
   image_url: ogImage || img?.src || null
 };
    });

    await browser.close();
    res.json(data);
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
