const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const ALIEXPRESS_EMAIL = process.env.ALIEXPRESS_EMAIL;
const ALIEXPRESS_PASSWORD = process.env.ALIEXPRESS_PASSWORD;
const API_SECRET = process.env.API_SECRET; // clé secrète pour sécuriser les appels

// Middleware de sécurité
app.use((req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Route principale : passer une commande
app.post('/place-order', async (req, res) => {
  const { aliexpress_url, quantity = 1, shipping_address } = req.body;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    // 1. Se connecter à AliExpress
    await page.goto('https://login.aliexpress.com', { waitUntil: 'networkidle2' });
    await page.waitForTimeout(2000);

    // Remplir email
    await page.type('#fm-login-id', ALIEXPRESS_EMAIL, { delay: 100 });
    await page.waitForTimeout(500);
    await page.type('#fm-login-password', ALIEXPRESS_PASSWORD, { delay: 100 });
    await page.waitForTimeout(500);
    await page.click('.password-login .fm-btn button');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    await page.waitForTimeout(3000);

    // 2. Aller sur le produit
    await page.goto(aliexpress_url, { waitUntil: 'networkidle2' });
    await page.waitForTimeout(3000);

    // 3. Cliquer "Buy Now"
    const buyBtn = await page.$('[class*="buy-now"]') || await page.$('[data-spm-anchor-id*="buy"]');
    if (!buyBtn) throw new Error('Bouton Buy Now introuvable');
    await buyBtn.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    await page.waitForTimeout(3000);

    // 4. Récupérer le numéro de commande
    const orderNumber = await page.$eval('[class*="order-number"]', el => el.textContent).catch(() => null);

    await browser.close();
    res.json({ success: true, order_number: orderNumber });

  } catch (error) {
    await browser.close();
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route santé
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(process.env.PORT || 3000, () => {
  console.log('SenShop Bot démarré ✅');
});
