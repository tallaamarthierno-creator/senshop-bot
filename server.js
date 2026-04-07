app.post('/scrape-product', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL manquante' });

    const browser = await puppeteer.launch({ 
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' });
    
    // Intercepter les requêtes API AliExpress directement
    let productData = null;
    page.on('response', async (response) => {
      const respUrl = response.url();
      if (respUrl.includes('detail.do') || respUrl.includes('rundetail')) {
        try {
          const json = await response.json();
          if (json?.data) productData = json.data;
        } catch {}
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 4000));

    const data = await page.evaluate(() => {
      // Chercher le JSON embarqué dans les scripts
      const scripts = Array.from(document.querySelectorAll('script'));
      let parsed = null;
      for (const s of scripts) {
        const t = s.textContent;
        if (t.includes('window.runParams') || t.includes('data:{"product')) {
          const match = t.match(/data:\s*(\{[\s\S]*?"productId"[\s\S]*?\})\s*[,;]/);
          if (match) { try { parsed = JSON.parse(match[1]); break; } catch {} }
        }
        if (t.includes('"titleModule"')) {
          const match = t.match(/\{[\s\S]*?"titleModule"[\s\S]*?\}/);
          if (match) { try { parsed = JSON.parse(match[0]); break; } catch {} }
        }
      }

      let name = 'Sans titre', price_usd = null, image_url = null;

      if (parsed) {
        name = parsed?.titleModule?.subject || parsed?.title || name;
        const price = parsed?.priceModule?.minAmount?.value || parsed?.priceModule?.formatedActivityPrice;
        price_usd = price ? parseFloat(String(price).replace(/[^\d.]/g, '')) : null;
        image_url = parsed?.imageModule?.imagePathList?.[0] || null;
      }

      // Fallback DOM
      if (name === 'Sans titre') {
        const h1 = document.querySelector('h1');
        name = h1?.textContent?.trim() || 'Sans titre';
      }
      if (!image_url) {
        const img = document.querySelector('.magnifier-image') || document.querySelector('img');
        image_url = img?.src || null;
      }

      return { name, price_usd, image_url, page_title: document.title };
    });

    await browser.close();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
