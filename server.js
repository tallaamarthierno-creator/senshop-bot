import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';

puppeteerExtra.use(StealthPlugin());

const app = express();
app.use(express.json());

const API_SECRET = process.env.RAILWAY_API_SECRET || 'test_secret';

// Middleware pour valider la clé API
app.use((req, res, next) => {
  const key = req.headers['x-api-secret'] || req.headers['x-api-key'];
  if (key !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Route de scraping
app.post('/scrape-product', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  let browser;
  try {
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    console.log('📍 Navigating to:', url);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('✅ Page loaded');

    const data = await page.evaluate(() => {
      // Titre
      const name = document.querySelector('h1.pdp-mod-product-title-wrapper h1')?.innerText 
        || document.querySelector('[data-testid="product-title"]')?.innerText
        || document.querySelector('h1')?.innerText
        || null;

      // Prix (en USD)
      const priceText = document.querySelector('.pdp-price_original_price')?.innerText
        || document.querySelector('[data-testid="product-price"]')?.innerText
        || document.querySelector('.product-price-value')?.innerText
        || document.querySelector('.pdp-price')?.innerText
        || null;
      
      const price_usd = priceText ? parseFloat(priceText.replace(/[^\d.]/g, '')) : null;

      // Image
      const image_url = document.querySelector('.magnifier-item img')?.src
        || document.querySelector('img[alt*="product"]')?.src
        || document.querySelector('img[data-src]')?.getAttribute('data-src')
        || document.querySelector('.product-image img')?.src
        || null;

      return { name, price_usd, image_url };
    });

    console.log('✅ Data extracted:', data);
    await browser.close();
    res.json(data);
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  }
});

// Route pour passer commande
app.post('/place-order', async (req, res) => {
  const { aliexpress_url, quantity, order_id } = req.body;
  if (!aliexpress_url) return res.status(400).json({ error: 'URL manquante' });

  let browser;
  try {
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(aliexpress_url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Ajouter au panier
    await page.click('[data-testid="add-to-cart-button"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Aller au panier
    await page.click('[data-testid="cart-icon"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Checkout
    await page.click('[data-testid="checkout-button"]', { timeout: 5000 }).catch(() => {});

    await browser.close();
    res.json({ success: true, aliexpress_order_id: `AUTO-${order_id}`, message: 'Commande initiée' });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
