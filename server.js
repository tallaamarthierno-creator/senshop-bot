import express from 'express';

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

  try {
    const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
    const encodedUrl = encodeURIComponent(url);
    const response = await fetch(
      `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodedUrl}`
    );
    const html = await response.text();

    console.log('STATUS:', response.status);
    console.log('HTML length:', html.length);

    // Extraire le nom
    const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
      || html.match(/"subject":"([^"]+)"/);
    const name = nameMatch?.[1]?.trim() || null;

    // Extraire le prix
    const priceMatch = html.match(/"minAmount":\{"value":(\d+\.?\d*)/);
    const price_usd = priceMatch ? parseFloat(priceMatch[1]) : null;

    // Extraire l'image
    const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    const image_url = imgMatch?.[1] || null;

    res.json({ name, price_usd, image_url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
    const html = await response.text();
    console.log('STATUS:', response.status);
console.log('HTML length:', html.length);
console.log('HTML début:', html.substring(0, 500));

    // Extraire window.runParams du HTML brut
    const match = html.match(/window\.runParams\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|let|const|<\/script>)/);
    if (match) {
      const json = JSON.parse(match[1]);
      const d = json?.data;
      const title = d?.titleModule?.subject;
      const price = d?.priceModule?.minAmount?.value || d?.priceModule?.minPrice?.value;
      const images = d?.imageModule?.imagePathList;

      if (title) {
        return res.json({
          name: title,
          price_usd: price ? parseFloat(String(price).replace(/[^\d.]/g, '')) || null : null,
          image_url: images?.[0] ? `https:${images[0]}` : null
        });
      }
    }

    // Fallback: meta tags dans le HTML brut
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
    const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];

    res.json({
      name: ogTitle || null,
      price_usd: null,
      image_url: ogImage || null
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
