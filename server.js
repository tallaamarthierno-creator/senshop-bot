import express from 'express';
import { chromium } from 'playwright';

const app = express();
app.use(express.json());

const API_SECRET = process.env.RAILWAY_API_SECRET;

// Route de debug AVANT le middleware d'auth
app.get('/debug-env', (req, res) => {
  res.json({
    ALIEXPRESS_MAIL: !!process.env.ALIEXPRESS_MAIL,
    ALIEXPRESS_PASSWORD: !!process.env.ALIEXPRESS_PASSWORD,
    RAILWAY_API_SECRET: !!process.env.RAILWAY_API_SECRET,
    MAIL_PREVIEW: (process.env.ALIEXPRESS_MAIL || '').substring(0, 10),
    SECRET_PREVIEW: (process.env.RAILWAY_API_SECRET || '').substring(0, 5),
  });
});

app.use((req, res, next) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Route existante — scraping produit
app.post('/scrape-product', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
  if (!SCRAPER_API_KEY) return res.status(500).json({ error: 'SCRAPER_API_KEY non configurée' });

  try {
    const encodedUrl = encodeURIComponent(url);
    const response = await fetch(`https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodedUrl}`);
    const html = await response.text();

    const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || html.match(/"subject":"([^"]+)"/);
    const name = nameMatch?.[1]?.trim() || null;

    const priceMatch = html.match(/"minAmount":\{"value":(\d+\.?\d*)/);
    const price_usd = priceMatch ? parseFloat(priceMatch[1]) : null;

    const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    const image_url = imgMatch?.[1] || null;

    res.json({ name, price_usd, image_url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Nouvelle route — passer une commande AliExpress automatiquement
app.post('/place-order', async (req, res) => {
  const { aliexpress_url, quantity, shipping_address, order_id } = req.body;

  if (!aliexpress_url || !shipping_address) {
    return res.status(400).json({ error: 'aliexpress_url et shipping_address requis' });
  }

  const ALIEXPRESS_MAIL = process.env.ALIEXPRESS_MAIL;
  const ALIEXPRESS_PASSWORD = process.env.ALIEXPRESS_PASSWORD;
  const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY;

  if (!ALIEXPRESS_MAIL || !ALIEXPRESS_PASSWORD) {
    return res.status(500).json({ error: 'Identifiants AliExpress non configurés' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'fr-FR',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    // 1. Connexion AliExpress
    console.log('[place-order] Connexion AliExpress...');
    await page.goto('https://login.aliexpress.com/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Remplir email
    await page.fill('input[name="loginId"], input[type="email"], #fm-login-id', ALIEXPRESS_MAIL);
    await page.waitForTimeout(500);

    // Remplir mot de passe
    await page.fill('input[name="password"], input[type="password"], #fm-login-password', ALIEXPRESS_PASSWORD);
    await page.waitForTimeout(500);

    // Cliquer connexion
    await page.click('button[type="submit"], .login-submit, #fm-login-submit');
    await page.waitForTimeout(4000);

    console.log('[place-order] URL après login:', page.url());

    // 2. Aller sur la page produit
    console.log('[place-order] Navigation vers le produit...');
    await page.goto(aliexpress_url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    // 3. Sélectionner la quantité si > 1
    if (quantity && quantity > 1) {
      try {
        const qtyInput = await page.$('input[class*="quantity"], input[data-role="quantity"]');
        if (qtyInput) {
          await qtyInput.triple_click();
          await qtyInput.type(String(quantity));
        }
      } catch (e) {
        console.log('[place-order] Quantité non modifiée:', e.message);
      }
    }

    // 4. Cliquer sur "Acheter maintenant" / "Buy Now"
    await page.waitForTimeout(2000);
    const buyNowSelectors = [
      'button:has-text("Buy Now")',
      'button:has-text("Acheter")',
      '[data-pl="buy-now"]',
      '.buy-now-btn',
      'a:has-text("Buy Now")'
    ];

    let clicked = false;
    for (const sel of buyNowSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          clicked = true;
          console.log('[place-order] Buy Now cliqué:', sel);
          break;
        }
      } catch (e) {}
    }

    if (!clicked) {
      throw new Error('Bouton Buy Now introuvable');
    }

    await page.waitForTimeout(4000);
    console.log('[place-order] URL après Buy Now:', page.url());

    // 5. Page de confirmation de commande (order confirmation)
    // Vérifier si on est sur la page de checkout
    const currentUrl = page.url();
    if (!currentUrl.includes('trade') && !currentUrl.includes('order') && !currentUrl.includes('checkout')) {
      throw new Error(`Redirection inattendue: ${currentUrl}`);
    }

    // 6. Vérifier/remplir l'adresse de livraison
    console.log('[place-order] Vérification adresse...');
    try {
      const addressField = await page.$('[class*="address"], [class*="shipping"]');
      if (addressField) {
        const addressText = await addressField.textContent();
        console.log('[place-order] Adresse actuelle:', addressText?.substring(0, 100));
      }
    } catch (e) {}

    // 7. Confirmer la commande
    await page.waitForTimeout(2000);
    const confirmSelectors = [
      'button:has-text("Place Order")',
      'button:has-text("Confirm Order")',
      'button:has-text("Passer la commande")',
      '[class*="place-order"]',
      '[class*="confirm-order"]',
      'button[type="submit"]:has-text("Order")'
    ];

    let confirmed = false;
    for (const sel of confirmSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          confirmed = true;
          console.log('[place-order] Commande confirmée avec:', sel);
          break;
        }
      } catch (e) {}
    }

    await page.waitForTimeout(5000);
    const finalUrl = page.url();
    console.log('[place-order] URL finale:', finalUrl);

    // 8. Extraire l'ID de commande AliExpress
    let aliexpress_order_id = null;
    const orderIdMatch = finalUrl.match(/orderId=(\d+)/) || finalUrl.match(/order\/(\d+)/);
    if (orderIdMatch) aliexpress_order_id = orderIdMatch[1];

    if (!aliexpress_order_id) {
      // Essayer de l'extraire de la page
      try {
        const pageContent = await page.content();
        const contentMatch = pageContent.match(/"orderId":"?(\d+)"?/);
        if (contentMatch) aliexpress_order_id = contentMatch[1];
      } catch (e) {}
    }

    await browser.close();

    return res.json({
      success: true,
      aliexpress_order_id: aliexpress_order_id || `manual_${order_id}`,
      message: confirmed ? 'Commande passée avec succès' : 'Commande initiée (vérification manuelle requise)',
      final_url: finalUrl
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('[place-order] ERREUR:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
