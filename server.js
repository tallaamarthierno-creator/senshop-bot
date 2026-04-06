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
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const data = await page.evaluate(() => {
      const title = document.querySelector('h1')?.innerText || document.querySelector('[data-testid="product-title"]')?.innerText;
      const priceText = document.querySelector('[data-testid="price-now"]')?.innerText || 
                        document.querySelector('.search-price-main')?.innerText;
      const price = priceText ? parseFloat(priceText.replace(/[^\d.]/g, '')) : null;
      const img = document.querySelector('img[src*="aliexpress"]') || document.querySelector('img[alt]');
      const imageUrl = img ? img.src : null;

      return { title, price_usd: price, image_url: imageUrl };
    });

    await browser.close();
    res.json(data);
  } catch (error) {
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

    // Clique sur le bouton "Ajouter au panier"
    await page.click('[data-testid="add-to-cart-button"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Ouvre le panier
    await page.click('[data-testid="cart-icon"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Procède au checkout
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
