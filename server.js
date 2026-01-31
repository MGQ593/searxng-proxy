/**
 * SearXNG Proxy Server
 * Version: 1.6.1
 * Last Update: 2026-01-31
 *
 * Cambios v1.6.1 (API Call Interception):
 * - /fetch-js ahora captura llamadas API JSON durante la carga de la página
 * - Nuevo campo apiCalls en respuesta con URLs de API y preview de datos
 * - Útil para descubrir endpoints de datos dinámicos
 *
 * Cambios v1.6.0 (Embedded JSON Extraction):
 * - Nueva función extractEmbeddedJsonData() para extraer datos JSON de scripts
 * - Detecta arrays de tiendas/ubicaciones, markers de Google Maps, y URLs de API
 * - Los endpoints /fetch y /fetch-js ahora incluyen campo embeddedData en respuesta
 * - Útil para páginas de localizadores de tiendas con datos dinámicos
 *
 * Cambios v1.5.0 (Deep Search):
 * - Nuevo endpoint /deep-search para búsqueda profunda con crawling
 * - Visita múltiples páginas de resultados y extrae contenido completo
 * - Sigue enlaces internos relevantes para mayor profundidad
 * - Consolidación inteligente de información de múltiples fuentes
 *
 * Cambios v1.4.0 (Seguridad):
 * - ELIMINADOS endpoints de debug (/info, /debug-rag, /rag-config) por seguridad
 * - Toda información de diagnóstico ahora se muestra en logs de consola del servidor
 * - Reducida superficie de ataque eliminando endpoints que exponían configuración
 *
 * Cambios v1.3.1:
 * - Fix: Esperar procesamiento asíncrono de archivos antes de agregar a Knowledge Base
 * - Previene error 400 "The content provided is empty" en Open WebUI
 * - Polling de estado de archivo hasta que esté procesado (máx 60 segundos)
 *
 * Cambios v1.3.0:
 * - Nuevo endpoint /upload-file para múltiples formatos (PDF, DOCX, XLSX, CSV, TXT)
 * - Soporte para mammoth (DOCX) y xlsx (Excel) libraries
 * - Extracción de texto de documentos para contexto AI
 *
 * Cambios v1.2.7:
 * - Fallback a todos los archivos de Open WebUI si la KB está vacía
 * - Mejor manejo de archivos subidos que no se asociaron a la KB
 *
 * Cambios v1.2.6:
 * - Mejorado /retrieve-only con múltiples estrategias de retrieval
 * - Soporte para diferentes formatos de collection_names en Open WebUI
 *
 * Cambios v1.2.5:
 * - Nuevo endpoint /retrieve-only para obtener fragmentos sin generación
 * - Permite usar RAG sin necesidad de modelo configurado en Open WebUI
 * - Los fragmentos se pasan al modelo principal (Azure OpenAI) del add-in
 *
 * Cambios v1.2.4:
 * - Modelo RAG configurable via OPENWEBUI_MODEL
 * - Si no se especifica modelo, Open WebUI usa el default del servidor
 *
 * Cambios v1.2.3:
 * - Corregido upload a Open WebUI: usar http/https nativo con form-data.pipe()
 * - fetch nativo de Node.js no maneja bien FormData multipart
 *
 * Cambios v1.2.1:
 * - Mejorada descarga de PDFs: sigue redirecciones y extrae URL real de páginas intermedias
 * - Verifica Content-Type y header PDF válido
 * - Extrae nombre de archivo de Content-Disposition
 *
 * Cambios v1.2.0:
 * - Mejorada detección de PDFs: ahora detecta enlaces dinámicos (sdm_process_download, etc.)
 * - Detecta PDFs por texto del enlace (descargar, boletín, informe)
 *
 * Cambios v1.1.0:
 * - Puppeteer ahora es opcional (carga dinámica)
 * - Mejor manejo de errores y SIGTERM
 * - Integración con Open WebUI RAG
 */

const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const FormData = require('form-data');

const VERSION = '1.6.1';
const BUILD_DATE = '2026-01-31T21:05:00Z';

// Document processing libraries (optional, load dynamically)
let mammoth = null;
let ExcelJS = null;

async function getMammoth() {
  if (!mammoth) {
    try {
      mammoth = require('mammoth');
      console.log('[Mammoth] Loaded successfully');
    } catch (error) {
      console.warn('[Mammoth] Not available:', error.message);
      return null;
    }
  }
  return mammoth;
}

async function getExcelJS() {
  if (!ExcelJS) {
    try {
      ExcelJS = require('exceljs');
      console.log('[ExcelJS] Loaded successfully');
    } catch (error) {
      console.warn('[ExcelJS] Not available:', error.message);
      return null;
    }
  }
  return ExcelJS;
}

// Puppeteer es opcional - cargarlo dinámicamente solo cuando se necesite
// Usamos puppeteer-core para evitar descarga automática de Chrome
let puppeteer = null;
async function getPuppeteer() {
  if (!puppeteer) {
    try {
      puppeteer = require('puppeteer-core');
      console.log('[Puppeteer] puppeteer-core loaded successfully');
    } catch (error) {
      console.warn('[Puppeteer] Not available:', error.message);
      return null;
    }
  }
  return puppeteer;
}

// Helper para encontrar Chrome en el sistema
function findChromePath() {
  const possiblePaths = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Environment variable override
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH
  ];

  const fs = require('fs');
  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

const app = express();
const PORT = process.env.PORT || 3000;

// URL de SearXNG (puede configurarse via variable de entorno)
const SEARXNG_URL = process.env.SEARXNG_URL || 'https://automatizacion-searxng.0hidyn.easypanel.host';

// Open WebUI Configuration
const OPENWEBUI_URL = process.env.OPENWEBUI_URL || 'https://sigai.planautomotor.com.ec';
const OPENWEBUI_API_KEY = process.env.OPENWEBUI_API_KEY || ''; // Clave API de Open WebUI
const OPENWEBUI_KNOWLEDGE_ID = process.env.OPENWEBUI_KNOWLEDGE_ID || ''; // ID de la Knowledge Base "EvoX_DocProxy"
const OPENWEBUI_MODEL = process.env.OPENWEBUI_MODEL || ''; // Modelo a usar (vacío = usar modelo por defecto del servidor)

// Habilitar CORS para todas las peticiones
app.use(cors());
// Aumentar límite de JSON para soportar archivos base64 (50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// NOTA: Endpoints de debug (/info, /debug-rag, /rag-config) fueron eliminados por seguridad
// Para debugging, usar los logs de consola del servidor

// Proxy de búsqueda
app.get('/search', async (req, res) => {
  try {
    const queryString = new URLSearchParams(req.query).toString();
    const url = `${SEARXNG_URL}/search?${queryString}`;

    console.log(`[Proxy] Buscando: ${req.query.q}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SearXNG-Proxy/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`SearXNG returned ${response.status}`);
    }

    const data = await response.json();
    console.log(`[Proxy] ${data.results?.length || 0} resultados`);

    res.json(data);
  } catch (error) {
    console.error('[Proxy] Error:', error.message);
    res.status(500).json({
      error: 'Error en búsqueda',
      message: error.message
    });
  }
});

// Proxy genérico para otros endpoints de SearXNG
app.get('/config', async (req, res) => {
  try {
    const response = await fetch(`${SEARXNG_URL}/config`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Helper: Extrae datos JSON embebidos en scripts de la página
 * Busca patrones comunes de datos de tiendas, markers, ubicaciones, etc.
 */
function extractEmbeddedJsonData(html) {
  const extractedData = {
    stores: [],
    locations: [],
    markers: [],
    jsonObjects: [],
    apiUrls: []
  };

  try {
    const $ = cheerio.load(html);

    // Buscar en todos los scripts
    $('script').each((i, script) => {
      const scriptContent = $(script).html() || '';
      if (!scriptContent || scriptContent.length < 20) return;

      // Patrones comunes de datos de tiendas/ubicaciones
      const patterns = [
        // Arrays de objetos con coordenadas
        /(?:var|let|const|window\.)\s*(\w+)\s*=\s*(\[[\s\S]*?(?:lat|lng|latitude|longitude|address|direccion|ciudad|city|nombre|name|tienda|store|sucursal|local)[\s\S]*?\]);?/gi,
        // JSON.parse de datos
        /JSON\.parse\s*\(\s*['"`]([\s\S]*?)['"`]\s*\)/gi,
        // __INITIAL_STATE__ o similar
        /window\.__(?:INITIAL_STATE|DATA|PRELOADED_STATE|NUXT)__\s*=\s*(\{[\s\S]*?\});?/gi,
        // data-* attributes con JSON
        /data-(?:stores|locations|markers|points)\s*=\s*['"](\[[\s\S]*?\])['"]*/gi,
      ];

      // Buscar arrays de objetos con estructura de tiendas
      const storeArrayPattern = /\[\s*\{[^[\]]*(?:lat|lng|latitude|longitude|address|direccion|ciudad|city|nombre|name|tienda|store|sucursal|local)[^[\]]*\}(?:\s*,\s*\{[^[\]]*\})*\s*\]/gi;
      let match;

      while ((match = storeArrayPattern.exec(scriptContent)) !== null) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // Verificar que parece datos de tiendas
            const sample = parsed[0];
            if (sample && typeof sample === 'object') {
              const keys = Object.keys(sample).join(' ').toLowerCase();
              if (keys.match(/lat|lng|address|nombre|name|tienda|store|city|ciudad|direccion/)) {
                extractedData.stores.push(...parsed);
              }
            }
          }
        } catch (e) {
          // JSON inválido, ignorar
        }
      }

      // Buscar markers de Google Maps
      const markerPattern = /(?:new\s+google\.maps\.Marker|markers\.push|addMarker)\s*\(\s*\{([^}]+(?:lat|lng|position)[^}]+)\}/gi;
      while ((match = markerPattern.exec(scriptContent)) !== null) {
        try {
          // Intentar extraer lat/lng
          const latMatch = match[1].match(/lat[itude]*\s*:\s*([-\d.]+)/i);
          const lngMatch = match[1].match(/(?:lng|lon|longitude)\s*:\s*([-\d.]+)/i);
          const titleMatch = match[1].match(/title\s*:\s*['"`]([^'"`]+)['"`]/i);

          if (latMatch && lngMatch) {
            extractedData.markers.push({
              lat: parseFloat(latMatch[1]),
              lng: parseFloat(lngMatch[1]),
              title: titleMatch ? titleMatch[1] : null
            });
          }
        } catch (e) {
          // Error extrayendo marker
        }
      }

      // Buscar URLs de API que devuelvan JSON
      const apiUrlPattern = /['"`]((?:https?:)?\/\/[^'"`\s]+(?:api|json|stores|locations|sucursales|tiendas)[^'"`\s]*)['"`]/gi;
      while ((match = apiUrlPattern.exec(scriptContent)) !== null) {
        const apiUrl = match[1];
        if (!extractedData.apiUrls.includes(apiUrl)) {
          extractedData.apiUrls.push(apiUrl);
        }
      }
    });

    // También buscar en data attributes del HTML
    $('[data-stores], [data-locations], [data-markers], [data-json]').each((i, el) => {
      const dataAttrs = ['data-stores', 'data-locations', 'data-markers', 'data-json'];
      dataAttrs.forEach(attr => {
        const value = $(el).attr(attr);
        if (value) {
          try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
              extractedData.jsonObjects.push(...parsed);
            } else if (typeof parsed === 'object') {
              extractedData.jsonObjects.push(parsed);
            }
          } catch (e) {
            // JSON inválido
          }
        }
      });
    });

  } catch (error) {
    console.error('[ExtractJSON] Error:', error.message);
  }

  // Consolidar resultados únicos
  const hasData = extractedData.stores.length > 0 ||
                  extractedData.markers.length > 0 ||
                  extractedData.jsonObjects.length > 0 ||
                  extractedData.apiUrls.length > 0;

  return {
    found: hasData,
    ...extractedData,
    totalItems: extractedData.stores.length + extractedData.markers.length + extractedData.jsonObjects.length
  };
}

// Fetch y parseo de contenido web
app.get('/fetch', async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    console.log(`[Fetch] Obteniendo: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // Si es JSON, devolverlo directamente
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return res.json({ type: 'json', data, url });
    }

    const html = await response.text();

    // Extraer datos JSON embebidos ANTES de remover scripts
    const embeddedData = extractEmbeddedJsonData(html);
    if (embeddedData.found) {
      console.log(`[Fetch] Datos embebidos encontrados: ${embeddedData.totalItems} items, ${embeddedData.apiUrls.length} APIs`);
    }

    const $ = cheerio.load(html);

    // Remover scripts, styles y elementos no deseados
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();

    // Extraer título
    const title = $('title').text().trim() || $('h1').first().text().trim();

    // Extraer texto principal (párrafos, listas, headings)
    const textContent = [];
    $('p, li, h1, h2, h3, h4, h5, h6, td, th').each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 10) {
        textContent.push(text);
      }
    });

    // Extraer tablas
    const tables = [];
    $('table').each((tableIndex, table) => {
      const tableData = {
        headers: [],
        rows: []
      };

      // Headers
      $(table).find('thead tr th, thead tr td, tr:first-child th').each((i, th) => {
        tableData.headers.push($(th).text().trim());
      });

      // Si no hay thead, usar primera fila como headers
      if (tableData.headers.length === 0) {
        $(table).find('tr:first-child td').each((i, td) => {
          tableData.headers.push($(td).text().trim());
        });
      }

      // Rows
      $(table).find('tbody tr, tr').each((rowIndex, tr) => {
        // Skip header row if we already extracted it
        if (rowIndex === 0 && tableData.headers.length > 0) {
          const firstRowCells = $(tr).find('th, td');
          if (firstRowCells.length === tableData.headers.length) {
            let isHeader = true;
            firstRowCells.each((i, cell) => {
              if ($(cell).text().trim() !== tableData.headers[i]) {
                isHeader = false;
              }
            });
            if (isHeader) return;
          }
        }

        const row = [];
        $(tr).find('td, th').each((i, td) => {
          row.push($(td).text().trim());
        });
        if (row.length > 0 && row.some(cell => cell.length > 0)) {
          tableData.rows.push(row);
        }
      });

      if (tableData.rows.length > 0 || tableData.headers.length > 0) {
        tables.push(tableData);
      }
    });

    // Extraer enlaces relevantes (PDFs, Excel, etc)
    const downloadLinks = [];
    const seenUrls = new Set(); // Evitar duplicados

    $('a[href]').each((i, a) => {
      const href = $(a).attr('href');
      const text = $(a).text().trim().toLowerCase();
      const hrefLower = (href || '').toLowerCase();

      if (!href) return;

      let type = null;

      // Detección por extensión de archivo
      if (hrefLower.endsWith('.pdf')) type = 'pdf';
      else if (hrefLower.endsWith('.xlsx')) type = 'xlsx';
      else if (hrefLower.endsWith('.xls')) type = 'xls';
      else if (hrefLower.endsWith('.csv')) type = 'csv';
      // Detección por patrones de descarga en la URL
      else if (hrefLower.includes('download') && (text.includes('pdf') || hrefLower.includes('pdf'))) type = 'pdf';
      else if (hrefLower.includes('sdm_process_download')) type = 'pdf'; // WordPress Download Manager
      else if (hrefLower.includes('/descargar') || hrefLower.includes('/download')) {
        // Inferir tipo del texto del enlace
        if (text.includes('pdf')) type = 'pdf';
        else if (text.includes('excel') || text.includes('xlsx')) type = 'xlsx';
        else type = 'pdf'; // Default a PDF para enlaces de descarga
      }
      // Detección por texto del enlace que indica descarga
      else if ((text.includes('descargar') || text.includes('download')) &&
               (text.includes('pdf') || text.includes('boletín') || text.includes('informe') || text.includes('reporte'))) {
        type = 'pdf';
      }

      if (type) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, url).href;
        if (!seenUrls.has(fullUrl)) {
          seenUrls.add(fullUrl);
          downloadLinks.push({
            text: $(a).text().trim() || href,
            url: fullUrl,
            type
          });
        }
      }
    });

    console.log(`[Fetch] Extraído: ${textContent.length} textos, ${tables.length} tablas, ${downloadLinks.length} archivos`);

    res.json({
      type: 'html',
      url,
      title,
      textContent: textContent.slice(0, 50), // Limitar a 50 párrafos
      tables: tables.slice(0, 10), // Limitar a 10 tablas
      downloadLinks: downloadLinks.slice(0, 20), // Limitar a 20 enlaces
      embeddedData: embeddedData.found ? embeddedData : undefined, // Datos JSON extraídos de scripts
      fetchedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[Fetch] Error:', error.message);
    res.status(500).json({
      error: 'Error fetching URL',
      message: error.message
    });
  }
});

// Fetch con Puppeteer para sitios JavaScript-heavy
app.get('/fetch-js', async (req, res) => {
  let browser = null;

  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    // Cargar Puppeteer dinámicamente
    const pup = await getPuppeteer();
    if (!pup) {
      return res.status(503).json({
        error: 'Puppeteer not available',
        message: 'JavaScript rendering is not available on this server. Use /fetch instead.',
        suggestion: 'Try using the static fetch endpoint: /fetch'
      });
    }

    console.log(`[FetchJS] Obteniendo con Puppeteer: ${url}`);

    // Buscar Chrome en el sistema
    const chromePath = findChromePath();
    if (!chromePath) {
      return res.status(503).json({
        error: 'Chrome not found',
        message: 'No se encontró Chrome/Chromium instalado en el sistema. Use /fetch para contenido estático.',
        suggestion: 'Instale Google Chrome o configure CHROME_PATH variable de entorno'
      });
    }

    console.log(`[FetchJS] Usando Chrome: ${chromePath}`);

    // Iniciar browser con configuración para Docker/Windows
    const launchOptions = {
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--window-size=1920x1080'
      ]
    };

    browser = await pup.launch(launchOptions);

    const page = await browser.newPage();

    // Capturar llamadas API/JSON que hace la página
    const apiCalls = [];
    await page.setRequestInterception(true);

    page.on('request', request => {
      request.continue();
    });

    page.on('response', async response => {
      try {
        const contentType = response.headers()['content-type'] || '';
        const reqUrl = response.url();

        // Capturar respuestas JSON de APIs (no scripts de librerías)
        if (contentType.includes('application/json') &&
            !reqUrl.includes('googleapis.com') &&
            !reqUrl.includes('google.com/maps') &&
            !reqUrl.includes('gstatic.com') &&
            !reqUrl.includes('facebook') &&
            !reqUrl.includes('analytics')) {

          const responseData = await response.json().catch(() => null);
          if (responseData) {
            apiCalls.push({
              url: reqUrl,
              method: response.request().method(),
              status: response.status(),
              dataPreview: JSON.stringify(responseData).substring(0, 500),
              isArray: Array.isArray(responseData),
              itemCount: Array.isArray(responseData) ? responseData.length : null
            });
            console.log(`[FetchJS] API call captured: ${reqUrl}`);
          }
        }
      } catch (e) {
        // Ignorar errores de parsing
      }
    });

    // Configurar user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Configurar viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Navegar a la URL con timeout de 30 segundos
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Esperar un poco más para que el JS se ejecute
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Obtener el HTML renderizado
    const html = await page.content();

    await browser.close();
    browser = null;

    // Extraer datos JSON embebidos ANTES de remover scripts
    const embeddedData = extractEmbeddedJsonData(html);
    if (embeddedData.found) {
      console.log(`[FetchJS] Datos embebidos encontrados: ${embeddedData.totalItems} items, ${embeddedData.apiUrls.length} APIs`);
    }

    // Parsear con cheerio
    const $ = cheerio.load(html);

    // Remover scripts, styles y elementos no deseados
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();

    // Extraer título
    const title = $('title').text().trim() || $('h1').first().text().trim();

    // Extraer texto principal
    const textContent = [];
    $('p, li, h1, h2, h3, h4, h5, h6, td, th, span, div').each((i, el) => {
      const text = $(el).clone().children().remove().end().text().trim();
      if (text && text.length > 10 && !textContent.includes(text)) {
        textContent.push(text);
      }
    });

    // Extraer tablas
    const tables = [];
    $('table').each((tableIndex, table) => {
      const tableData = {
        headers: [],
        rows: []
      };

      $(table).find('thead tr th, thead tr td, tr:first-child th').each((i, th) => {
        tableData.headers.push($(th).text().trim());
      });

      if (tableData.headers.length === 0) {
        $(table).find('tr:first-child td').each((i, td) => {
          tableData.headers.push($(td).text().trim());
        });
      }

      $(table).find('tbody tr, tr').each((rowIndex, tr) => {
        if (rowIndex === 0 && tableData.headers.length > 0) {
          const firstRowCells = $(tr).find('th, td');
          if (firstRowCells.length === tableData.headers.length) {
            let isHeader = true;
            firstRowCells.each((i, cell) => {
              if ($(cell).text().trim() !== tableData.headers[i]) {
                isHeader = false;
              }
            });
            if (isHeader) return;
          }
        }

        const row = [];
        $(tr).find('td, th').each((i, td) => {
          row.push($(td).text().trim());
        });
        if (row.length > 0 && row.some(cell => cell.length > 0)) {
          tableData.rows.push(row);
        }
      });

      if (tableData.rows.length > 0 || tableData.headers.length > 0) {
        tables.push(tableData);
      }
    });

    // Extraer enlaces de descarga (mejorado para detectar enlaces dinámicos)
    const downloadLinks = [];
    const seenUrls = new Set();

    $('a[href]').each((i, a) => {
      const href = $(a).attr('href');
      const text = $(a).text().trim().toLowerCase();
      const hrefLower = (href || '').toLowerCase();

      if (!href) return;

      let type = null;

      // Detección por extensión
      if (hrefLower.endsWith('.pdf')) type = 'pdf';
      else if (hrefLower.endsWith('.xlsx')) type = 'xlsx';
      else if (hrefLower.endsWith('.xls')) type = 'xls';
      else if (hrefLower.endsWith('.csv')) type = 'csv';
      // Detección por patrones de descarga
      else if (hrefLower.includes('download') && (text.includes('pdf') || hrefLower.includes('pdf'))) type = 'pdf';
      else if (hrefLower.includes('sdm_process_download')) type = 'pdf';
      else if (hrefLower.includes('/descargar') || hrefLower.includes('/download')) {
        if (text.includes('pdf')) type = 'pdf';
        else if (text.includes('excel') || text.includes('xlsx')) type = 'xlsx';
        else type = 'pdf';
      }
      else if ((text.includes('descargar') || text.includes('download')) &&
               (text.includes('pdf') || text.includes('boletín') || text.includes('informe') || text.includes('reporte'))) {
        type = 'pdf';
      }

      if (type) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, url).href;
        if (!seenUrls.has(fullUrl)) {
          seenUrls.add(fullUrl);
          downloadLinks.push({
            text: $(a).text().trim() || href,
            url: fullUrl,
            type
          });
        }
      }
    });

    console.log(`[FetchJS] Extraído: ${textContent.length} textos, ${tables.length} tablas, ${downloadLinks.length} archivos, ${apiCalls.length} API calls`);

    res.json({
      type: 'html',
      url,
      title,
      textContent: textContent.slice(0, 50),
      tables: tables.slice(0, 10),
      downloadLinks: downloadLinks.slice(0, 20),
      embeddedData: embeddedData.found ? embeddedData : undefined, // Datos JSON extraídos de scripts
      apiCalls: apiCalls.length > 0 ? apiCalls : undefined, // Llamadas API JSON capturadas durante la carga
      fetchedAt: new Date().toISOString(),
      renderedWith: 'puppeteer'
    });

  } catch (error) {
    console.error('[FetchJS] Error:', error.message);
    if (browser) {
      await browser.close();
    }
    res.status(500).json({
      error: 'Error fetching URL with Puppeteer',
      message: error.message
    });
  }
});

// ===== Deep Search - Búsqueda profunda con crawling =====

/**
 * Helper: Extrae contenido de una URL de forma simplificada
 */
async function extractPageContent(url, timeout = 15000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return { success: false, error: 'Not HTML content' };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remover elementos no deseados
    $('script, style, nav, footer, header, aside, iframe, noscript, .advertisement, .ad, .sidebar, .menu, .navigation').remove();

    // Extraer título
    const title = $('title').text().trim() || $('h1').first().text().trim();

    // Extraer contenido principal - priorizar article, main, o contenido principal
    let mainContent = '';
    const mainSelectors = ['article', 'main', '.content', '.post-content', '.entry-content', '#content', '.article-body'];

    for (const selector of mainSelectors) {
      const content = $(selector).text().trim();
      if (content && content.length > mainContent.length) {
        mainContent = content;
      }
    }

    // Si no encontró contenido principal, usar body
    if (!mainContent || mainContent.length < 200) {
      mainContent = $('body').text().trim();
    }

    // Limpiar espacios múltiples y líneas vacías
    mainContent = mainContent.replace(/\s+/g, ' ').trim();

    // Extraer párrafos relevantes
    const paragraphs = [];
    $('p').each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 50 && text.length < 2000) {
        paragraphs.push(text);
      }
    });

    // Extraer enlaces internos relevantes (para seguir crawleando)
    const internalLinks = [];
    const baseUrl = new URL(url);

    $('a[href]').each((i, a) => {
      const href = $(a).attr('href');
      if (!href) return;

      try {
        const linkUrl = new URL(href, url);
        // Solo enlaces del mismo dominio
        if (linkUrl.hostname === baseUrl.hostname) {
          const linkText = $(a).text().trim();
          if (linkText && linkText.length > 5 && linkText.length < 100) {
            // Evitar enlaces de navegación comunes
            const skipPatterns = /login|logout|register|signup|cart|checkout|search|contact|about|privacy|terms|cookie/i;
            if (!skipPatterns.test(linkUrl.pathname) && !skipPatterns.test(linkText)) {
              internalLinks.push({
                url: linkUrl.href,
                text: linkText
              });
            }
          }
        }
      } catch (e) {
        // URL inválida, ignorar
      }
    });

    return {
      success: true,
      url,
      title,
      content: mainContent.substring(0, 8000), // Limitar contenido
      paragraphs: paragraphs.slice(0, 10),
      internalLinks: internalLinks.slice(0, 10),
      contentLength: mainContent.length
    };

  } catch (error) {
    return {
      success: false,
      url,
      error: error.name === 'AbortError' ? 'Timeout' : error.message
    };
  }
}

/**
 * Deep Search - Búsqueda profunda con crawling de múltiples páginas
 * POST /deep-search
 * Body: {
 *   query: string,           // Consulta de búsqueda
 *   maxResults?: number,     // Máximo resultados de búsqueda a visitar (default: 5)
 *   maxDepth?: number,       // Profundidad de crawling (0=solo resultados, 1=seguir 1 nivel de links)
 *   maxPagesPerSite?: number,// Máximo páginas por sitio (default: 3)
 *   language?: string        // Idioma de búsqueda (default: 'es')
 * }
 */
app.post('/deep-search', async (req, res) => {
  try {
    const {
      query,
      maxResults = 5,
      maxDepth = 1,
      maxPagesPerSite = 3,
      language = 'es'
    } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    console.log(`[DeepSearch] Iniciando búsqueda profunda: "${query}"`);
    console.log(`[DeepSearch] Config: maxResults=${maxResults}, maxDepth=${maxDepth}, maxPagesPerSite=${maxPagesPerSite}`);

    const startTime = Date.now();

    // 1. Realizar búsqueda en SearXNG
    const searchParams = new URLSearchParams({
      q: query,
      format: 'json',
      language: language,
      safesearch: '1',
      categories: 'general'
    });

    const searchResponse = await fetch(`${SEARXNG_URL}/search?${searchParams.toString()}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SearXNG-Proxy/1.0'
      }
    });

    if (!searchResponse.ok) {
      throw new Error(`Error en búsqueda SearXNG: ${searchResponse.status}`);
    }

    const searchData = await searchResponse.json();
    const searchResults = (searchData.results || []).slice(0, maxResults);

    console.log(`[DeepSearch] ${searchResults.length} resultados de búsqueda encontrados`);

    // 2. Visitar cada resultado y extraer contenido
    const visitedUrls = new Set();
    const allContent = [];
    const errors = [];

    for (const result of searchResults) {
      if (visitedUrls.has(result.url)) continue;
      visitedUrls.add(result.url);

      console.log(`[DeepSearch] Visitando: ${result.url}`);

      const pageContent = await extractPageContent(result.url);

      if (pageContent.success) {
        allContent.push({
          url: result.url,
          title: pageContent.title || result.title,
          snippet: result.content,
          fullContent: pageContent.content,
          paragraphs: pageContent.paragraphs,
          source: result.engine,
          depth: 0
        });

        // 3. Si maxDepth > 0, seguir enlaces internos relevantes
        if (maxDepth > 0 && pageContent.internalLinks) {
          const sitePagesVisited = 1;

          for (const link of pageContent.internalLinks) {
            if (sitePagesVisited >= maxPagesPerSite) break;
            if (visitedUrls.has(link.url)) continue;

            // Solo seguir si el texto del enlace parece relevante a la query
            const queryWords = query.toLowerCase().split(/\s+/);
            const linkTextLower = link.text.toLowerCase();
            const isRelevant = queryWords.some(word =>
              word.length > 3 && linkTextLower.includes(word)
            );

            if (isRelevant) {
              visitedUrls.add(link.url);
              console.log(`[DeepSearch] Siguiendo enlace: ${link.url}`);

              const subPageContent = await extractPageContent(link.url);

              if (subPageContent.success) {
                allContent.push({
                  url: link.url,
                  title: subPageContent.title,
                  linkText: link.text,
                  fullContent: subPageContent.content,
                  paragraphs: subPageContent.paragraphs,
                  parentUrl: result.url,
                  depth: 1
                });
              }
            }
          }
        }
      } else {
        errors.push({
          url: result.url,
          error: pageContent.error
        });
      }
    }

    const elapsedTime = Date.now() - startTime;
    console.log(`[DeepSearch] Completado: ${allContent.length} páginas extraídas en ${elapsedTime}ms`);

    // 4. Consolidar información para el AI
    let consolidatedText = `## Resultados de búsqueda profunda para: "${query}"\n\n`;
    consolidatedText += `Fuentes consultadas: ${allContent.length} páginas\n\n`;

    allContent.forEach((page, index) => {
      consolidatedText += `### ${index + 1}. ${page.title}\n`;
      consolidatedText += `**URL:** ${page.url}\n`;
      if (page.source) {
        consolidatedText += `**Fuente:** ${page.source}\n`;
      }
      consolidatedText += `\n${page.fullContent.substring(0, 2000)}${page.fullContent.length > 2000 ? '...' : ''}\n\n`;
    });

    res.json({
      success: true,
      query,
      totalPagesVisited: visitedUrls.size,
      totalContentExtracted: allContent.length,
      elapsedTimeMs: elapsedTime,
      pages: allContent,
      consolidatedText: consolidatedText.substring(0, 30000), // Limitar para no exceder contexto
      errors: errors.length > 0 ? errors : undefined,
      searchSuggestions: searchData.suggestions || []
    });

  } catch (error) {
    console.error('[DeepSearch] Error:', error.message);
    res.status(500).json({
      error: 'Error en búsqueda profunda',
      message: error.message
    });
  }
});

// ===== Open WebUI RAG Integration =====

/**
 * Helper: Obtiene el API Key (de variable de entorno o del request)
 */
function getApiKey(reqApiKey) {
  return OPENWEBUI_API_KEY || reqApiKey;
}

/**
 * Helper: Extrae texto de diferentes tipos de archivo
 */
async function extractTextFromFile(buffer, filename, mimeType) {
  const ext = filename.toLowerCase().split('.').pop();

  // PDF - usar pdf-parse si está disponible, o devolver indicación
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      return {
        success: true,
        text: data.text,
        pages: data.numpages,
        type: 'pdf'
      };
    } catch (error) {
      // Si pdf-parse no está disponible, devolver buffer para subir a Open WebUI
      console.log('[Extract] pdf-parse no disponible, se subirá directamente a Open WebUI');
      return {
        success: true,
        text: null,
        uploadToOpenWebUI: true,
        type: 'pdf'
      };
    }
  }

  // DOCX - usar mammoth
  if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammothLib = await getMammoth();
    if (!mammothLib) {
      return { success: false, error: 'mammoth library not installed. Run: npm install mammoth' };
    }

    try {
      const result = await mammothLib.extractRawText({ buffer: buffer });
      return {
        success: true,
        text: result.value,
        messages: result.messages,
        type: 'docx'
      };
    } catch (error) {
      return { success: false, error: `Error procesando DOCX: ${error.message}` };
    }
  }

  // XLSX/XLS - usar exceljs
  if (ext === 'xlsx' || ext === 'xls' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel') {
    const exceljs = await getExcelJS();
    if (!exceljs) {
      return { success: false, error: 'exceljs library not installed. Run: npm install exceljs' };
    }

    try {
      const workbook = new exceljs.Workbook();
      await workbook.xlsx.load(buffer);

      const sheets = {};
      const sheetNames = [];
      let allText = [];

      workbook.eachSheet((worksheet) => {
        const sheetName = worksheet.name;
        sheetNames.push(sheetName);

        // Convertir a CSV para texto legible
        const rows = [];
        worksheet.eachRow((row) => {
          const values = [];
          row.eachCell({ includeEmpty: true }, (cell) => {
            values.push(cell.text || '');
          });
          rows.push(values.join(','));
        });

        const csv = rows.join('\n');
        sheets[sheetName] = csv;
        allText.push(`=== Hoja: ${sheetName} ===\n${csv}`);
      });

      return {
        success: true,
        text: allText.join('\n\n'),
        sheets: sheets,
        sheetNames: sheetNames,
        type: 'xlsx'
      };
    } catch (error) {
      return { success: false, error: `Error procesando Excel: ${error.message}` };
    }
  }

  // CSV - lectura directa
  if (ext === 'csv' || mimeType === 'text/csv') {
    try {
      const text = buffer.toString('utf-8');
      return {
        success: true,
        text: text,
        type: 'csv'
      };
    } catch (error) {
      return { success: false, error: `Error procesando CSV: ${error.message}` };
    }
  }

  // TXT y otros archivos de texto
  if (ext === 'txt' || ext === 'md' || ext === 'json' || ext === 'xml' ||
      mimeType?.startsWith('text/') || mimeType === 'application/json') {
    try {
      const text = buffer.toString('utf-8');
      return {
        success: true,
        text: text,
        type: ext
      };
    } catch (error) {
      return { success: false, error: `Error procesando archivo de texto: ${error.message}` };
    }
  }

  return {
    success: false,
    error: `Tipo de archivo no soportado: ${ext} (${mimeType})`
  };
}

/**
 * Endpoint para subir archivos y extraer texto
 * POST /upload-file
 * Body: {
 *   file: string (base64),
 *   filename: string,
 *   mimeType?: string,
 *   uploadToRag?: boolean,
 *   knowledgeId?: string
 * }
 *
 * Soporta: PDF, DOCX, XLSX, XLS, CSV, TXT, MD, JSON, XML
 */
app.post('/upload-file', async (req, res) => {
  try {
    const { file, filename, mimeType, uploadToRag, knowledgeId } = req.body;
    const apiKey = getApiKey(req.body.apiKey);
    const kbId = knowledgeId || OPENWEBUI_KNOWLEDGE_ID;

    if (!file) {
      return res.status(400).json({ error: 'file (base64) is required' });
    }

    if (!filename) {
      return res.status(400).json({ error: 'filename is required' });
    }

    console.log(`[Upload] Procesando archivo: ${filename}`);

    // Decodificar base64
    const buffer = Buffer.from(file, 'base64');
    console.log(`[Upload] Tamaño: ${buffer.length} bytes`);

    // Extraer texto del archivo
    const extraction = await extractTextFromFile(buffer, filename, mimeType);

    if (!extraction.success) {
      return res.status(400).json({
        success: false,
        error: extraction.error,
        filename: filename
      });
    }

    // Si es PDF y necesita subirse a Open WebUI para procesamiento
    if (extraction.uploadToOpenWebUI && uploadToRag && apiKey) {
      console.log(`[Upload] Subiendo PDF a Open WebUI para procesamiento...`);

      // Usar el flujo existente de upload a Open WebUI
      const uploadResult = await new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', buffer, {
          filename: filename,
          contentType: 'application/pdf',
          knownLength: buffer.length
        });

        const uploadUrl = new URL(`${OPENWEBUI_URL}/api/v1/files/`);
        const options = {
          protocol: uploadUrl.protocol,
          host: uploadUrl.hostname,
          port: uploadUrl.port || (uploadUrl.protocol === 'https:' ? 443 : 80),
          path: uploadUrl.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...formData.getHeaders()
          }
        };

        const httpModule = uploadUrl.protocol === 'https:' ? require('https') : require('http');

        const req = httpModule.request(options, (response) => {
          let data = '';
          response.on('data', chunk => data += chunk);
          response.on('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(new Error(`Error parseando respuesta: ${data}`));
              }
            } else {
              reject(new Error(`Error subiendo: ${response.statusCode} - ${data}`));
            }
          });
        });

        req.on('error', (error) => {
          reject(new Error(`Error de conexión: ${error.message}`));
        });

        formData.pipe(req);
      });

      // Esperar a que el archivo sea procesado antes de agregar a KB
      console.log(`[Upload] Esperando procesamiento del archivo...`);
      const isProcessed = await waitForFileProcessing(uploadResult.id, apiKey);

      if (!isProcessed) {
        console.warn(`[Upload] El archivo puede no estar completamente procesado`);
      }

      // Agregar a Knowledge Base si se especificó
      let knowledgeResult = null;
      if (kbId) {
        const addToKbResponse = await fetch(`${OPENWEBUI_URL}/api/v1/knowledge/${kbId}/file/add`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ file_id: uploadResult.id })
        });

        if (addToKbResponse.ok) {
          knowledgeResult = await addToKbResponse.json();
        } else {
          const kbError = await addToKbResponse.text();
          console.warn(`[Upload] No se pudo agregar a KB: ${kbError}`);
        }
      }

      return res.json({
        success: true,
        filename: filename,
        type: extraction.type,
        text: null,
        message: 'PDF subido a Open WebUI para procesamiento',
        uploadedToRag: true,
        fileId: uploadResult.id,
        knowledgeBase: knowledgeResult
      });
    }

    // Subir a RAG si se solicita y hay texto extraído
    let ragResult = null;
    if (uploadToRag && apiKey && extraction.text) {
      console.log(`[Upload] Subiendo texto extraído a RAG...`);

      // Crear archivo de texto con el contenido extraído
      const textBuffer = Buffer.from(extraction.text, 'utf-8');
      const textFilename = filename.replace(/\.[^.]+$/, '.txt');

      const uploadResult = await new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', textBuffer, {
          filename: textFilename,
          contentType: 'text/plain',
          knownLength: textBuffer.length
        });

        const uploadUrl = new URL(`${OPENWEBUI_URL}/api/v1/files/`);
        const options = {
          protocol: uploadUrl.protocol,
          host: uploadUrl.hostname,
          port: uploadUrl.port || (uploadUrl.protocol === 'https:' ? 443 : 80),
          path: uploadUrl.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...formData.getHeaders()
          }
        };

        const httpModule = uploadUrl.protocol === 'https:' ? require('https') : require('http');

        const req = httpModule.request(options, (response) => {
          let data = '';
          response.on('data', chunk => data += chunk);
          response.on('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(new Error(`Error parseando respuesta: ${data}`));
              }
            } else {
              reject(new Error(`Error subiendo: ${response.statusCode} - ${data}`));
            }
          });
        });

        req.on('error', (error) => {
          reject(new Error(`Error de conexión: ${error.message}`));
        });

        formData.pipe(req);
      });

      ragResult = { fileId: uploadResult.id, filename: textFilename };

      // Esperar a que el archivo sea procesado antes de agregar a KB
      console.log(`[Upload] Esperando procesamiento del texto extraído...`);
      const isProcessed = await waitForFileProcessing(uploadResult.id, apiKey);

      if (!isProcessed) {
        console.warn(`[Upload] El archivo de texto puede no estar completamente procesado`);
      }

      // Agregar a Knowledge Base si se especificó
      if (kbId) {
        const addToKbResponse = await fetch(`${OPENWEBUI_URL}/api/v1/knowledge/${kbId}/file/add`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ file_id: uploadResult.id })
        });

        if (addToKbResponse.ok) {
          ragResult.knowledgeBase = await addToKbResponse.json();
        } else {
          const kbError = await addToKbResponse.text();
          console.warn(`[Upload] No se pudo agregar texto a KB: ${kbError}`);
        }
      }
    }

    console.log(`[Upload] Procesamiento exitoso: ${extraction.type}, ${extraction.text?.length || 0} caracteres`);

    res.json({
      success: true,
      filename: filename,
      type: extraction.type,
      text: extraction.text,
      textLength: extraction.text?.length || 0,
      sheets: extraction.sheets || null,
      sheetNames: extraction.sheetNames || null,
      uploadedToRag: !!ragResult,
      ragResult: ragResult
    });

  } catch (error) {
    console.error('[Upload] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Error procesando archivo',
      message: error.message
    });
  }
});

/**
 * Helper: Espera a que el archivo esté procesado
 */
async function waitForFileProcessing(fileId, apiKey, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const statusResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/${fileId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (statusResponse.ok) {
      const fileData = await statusResponse.json();
      // Verificar si el archivo tiene contenido procesado
      if (fileData.data && fileData.data.content) {
        console.log(`[RAG] Archivo procesado correctamente`);
        return true;
      }
    }

    console.log(`[RAG] Esperando procesamiento... (${i + 1}/${maxAttempts})`);
    await new Promise(resolve => setTimeout(resolve, 2000)); // Esperar 2 segundos
  }

  return false;
}

/**
 * Descarga un PDF y lo sube a Open WebUI Knowledge Base
 * POST /upload-to-rag
 * Body: { pdfUrl: string, filename?: string, knowledgeId?: string }
 *
 * Usa variables de entorno:
 * - OPENWEBUI_API_KEY: API Key de Open WebUI
 * - OPENWEBUI_KNOWLEDGE_ID: ID de la Knowledge Base
 */
app.post('/upload-to-rag', async (req, res) => {
  try {
    const { pdfUrl, filename, knowledgeId } = req.body;
    const apiKey = getApiKey(req.body.apiKey);
    const kbId = knowledgeId || OPENWEBUI_KNOWLEDGE_ID;

    if (!pdfUrl) {
      return res.status(400).json({ error: 'pdfUrl is required' });
    }

    if (!apiKey) {
      return res.status(400).json({
        error: 'API Key not configured',
        hint: 'Set OPENWEBUI_API_KEY environment variable or pass apiKey in request body'
      });
    }

    console.log(`[RAG] Descargando PDF: ${pdfUrl}`);

    // 1. Descargar el PDF (siguiendo redirecciones)
    let pdfResponse = await fetch(pdfUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*'
      },
      redirect: 'follow'
    });

    if (!pdfResponse.ok) {
      throw new Error(`Error descargando PDF: ${pdfResponse.status}`);
    }

    // Verificar el Content-Type
    const contentType = pdfResponse.headers.get('content-type') || '';
    console.log(`[RAG] Content-Type recibido: ${contentType}`);

    // Si es HTML, puede ser una página de descarga - intentar extraer el link real
    if (contentType.includes('text/html')) {
      const htmlContent = await pdfResponse.text();

      // Buscar meta refresh o link directo al PDF
      const metaRefreshMatch = htmlContent.match(/url=([^"'\s>]+\.pdf[^"'\s>]*)/i);
      const directLinkMatch = htmlContent.match(/href=["']([^"']+\.pdf[^"']*)["']/i);

      let realPdfUrl = null;
      if (metaRefreshMatch) {
        realPdfUrl = metaRefreshMatch[1];
      } else if (directLinkMatch) {
        realPdfUrl = directLinkMatch[1];
      }

      if (realPdfUrl) {
        // Construir URL completa si es relativa
        if (!realPdfUrl.startsWith('http')) {
          const baseUrl = new URL(pdfUrl);
          realPdfUrl = new URL(realPdfUrl, baseUrl.origin).href;
        }

        console.log(`[RAG] Redirigiendo a PDF real: ${realPdfUrl}`);
        pdfResponse = await fetch(realPdfUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/pdf,*/*'
          },
          redirect: 'follow'
        });

        if (!pdfResponse.ok) {
          throw new Error(`Error descargando PDF real: ${pdfResponse.status}`);
        }
      } else {
        throw new Error('El enlace no apunta a un PDF válido. Recibido: HTML sin link a PDF');
      }
    }

    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());

    // Verificar que sea un PDF válido (los PDFs empiezan con %PDF)
    const pdfHeader = pdfBuffer.slice(0, 5).toString();
    if (!pdfHeader.startsWith('%PDF')) {
      console.warn(`[RAG] Advertencia: El archivo no parece ser un PDF válido. Header: ${pdfHeader}`);
    }

    // Obtener nombre del archivo
    let pdfFilename = filename;
    if (!pdfFilename) {
      // Intentar obtener de Content-Disposition
      const contentDisposition = pdfResponse.headers.get('content-disposition');
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename[*]?=["']?(?:UTF-8'')?([^"';\n]+)/i);
        if (filenameMatch) {
          pdfFilename = decodeURIComponent(filenameMatch[1]);
        }
      }
    }
    if (!pdfFilename) {
      pdfFilename = decodeURIComponent(pdfUrl.split('/').pop().split('?')[0]) || 'document.pdf';
    }
    // Asegurar extensión .pdf
    if (!pdfFilename.toLowerCase().endsWith('.pdf')) {
      pdfFilename += '.pdf';
    }

    console.log(`[RAG] PDF descargado: ${pdfFilename} (${pdfBuffer.length} bytes)`);

    // 2. Subir a Open WebUI Files API usando form-data submit (más confiable que fetch)
    console.log(`[RAG] Subiendo a Open WebUI: ${OPENWEBUI_URL} (${pdfBuffer.length} bytes)`);

    const uploadResult = await new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', pdfBuffer, {
        filename: pdfFilename,
        contentType: 'application/pdf',
        knownLength: pdfBuffer.length
      });

      const uploadUrl = new URL(`${OPENWEBUI_URL}/api/v1/files/`);
      const options = {
        protocol: uploadUrl.protocol,
        host: uploadUrl.hostname,
        port: uploadUrl.port || (uploadUrl.protocol === 'https:' ? 443 : 80),
        path: uploadUrl.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formData.getHeaders()
        }
      };

      const httpModule = uploadUrl.protocol === 'https:' ? require('https') : require('http');

      const req = httpModule.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Error parseando respuesta: ${data}`));
            }
          } else {
            reject(new Error(`Error subiendo a Open WebUI: ${response.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Error de conexión: ${error.message}`));
      });

      formData.pipe(req);
    });
    console.log(`[RAG] Archivo subido con ID:`, uploadResult.id);

    // 4. Esperar a que el archivo sea procesado
    console.log(`[RAG] Esperando procesamiento del archivo...`);
    const isProcessed = await waitForFileProcessing(uploadResult.id, apiKey);

    if (!isProcessed) {
      console.warn(`[RAG] El archivo puede no estar completamente procesado`);
    }

    // 5. Agregar a Knowledge Base si se especificó
    let knowledgeResult = null;
    if (kbId) {
      console.log(`[RAG] Agregando a Knowledge Base: ${kbId}`);

      const addToKbResponse = await fetch(`${OPENWEBUI_URL}/api/v1/knowledge/${kbId}/file/add`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: uploadResult.id })
      });

      if (addToKbResponse.ok) {
        knowledgeResult = await addToKbResponse.json();
        console.log(`[RAG] Archivo agregado a Knowledge Base`);
      } else {
        const kbError = await addToKbResponse.text();
        console.warn(`[RAG] No se pudo agregar a KB: ${kbError}`);
      }
    }

    res.json({
      success: true,
      message: kbId ? 'PDF subido a Knowledge Base' : 'PDF subido a Open WebUI',
      file: uploadResult,
      knowledgeBase: knowledgeResult,
      originalUrl: pdfUrl
    });

  } catch (error) {
    console.error('[RAG] Error:', error.message);
    res.status(500).json({
      error: 'Error subiendo PDF a RAG',
      message: error.message
    });
  }
});

/**
 * Consulta el RAG de Open WebUI usando Knowledge Base
 * POST /query-rag
 * Body: { query: string, model?: string, knowledgeId?: string }
 */
app.post('/query-rag', async (req, res) => {
  try {
    const { query, model, knowledgeId } = req.body;
    const apiKey = getApiKey(req.body.apiKey);
    const kbId = knowledgeId || OPENWEBUI_KNOWLEDGE_ID;

    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key not configured' });
    }

    console.log(`[RAG] Consultando: ${query}`);

    // Construir request body
    // Usar el modelo especificado, o el configurado en env, o dejar que Open WebUI use el default
    const modelToUse = model || OPENWEBUI_MODEL;
    const requestBody = {
      messages: [
        {
          role: 'user',
          content: query
        }
      ],
      stream: false
    };

    // Solo incluir model si hay uno especificado
    if (modelToUse) {
      requestBody.model = modelToUse;
    }

    // Si hay Knowledge Base, usar como collection
    if (kbId) {
      requestBody.files = [
        {
          type: 'collection',
          id: kbId
        }
      ];
    }

    const response = await fetch(`${OPENWEBUI_URL}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Error en consulta RAG: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`[RAG] Respuesta recibida`);

    res.json({
      success: true,
      response: result.choices?.[0]?.message?.content || result.message?.content || result,
      usage: result.usage,
      knowledgeBaseUsed: kbId || null
    });

  } catch (error) {
    console.error('[RAG] Query error:', error.message);
    res.status(500).json({
      error: 'Error consultando RAG',
      message: error.message
    });
  }
});


/**
 * Retrieval-only: Obtiene fragmentos relevantes sin generación
 * POST /retrieve-only
 * Body: { query: string, knowledgeId?: string, topK?: number }
 *
 * Esto permite usar RAG sin necesidad de tener un modelo configurado en Open WebUI.
 * Los fragmentos retornados pueden pasarse al modelo principal del add-in (Azure OpenAI).
 */
app.post('/retrieve-only', async (req, res) => {
  try {
    const { query, knowledgeId, topK = 8 } = req.body;
    const apiKey = getApiKey(req.body.apiKey);
    const kbId = knowledgeId || OPENWEBUI_KNOWLEDGE_ID;

    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key not configured' });
    }

    if (!kbId) {
      return res.status(400).json({ error: 'Knowledge Base ID not configured' });
    }

    console.log(`[RAG] Retrieval-only para: "${query}" (top ${topK})`);

    // Estrategia 1: Intentar retrieval vectorial con diferentes formatos de collection_name
    const collectionFormats = [
      kbId,                    // ID directo
      `file-${kbId}`,          // Con prefijo file-
    ];

    let retrievalSuccess = false;
    let chunks = [];
    let usedMethod = 'none';

    for (const collectionName of collectionFormats) {
      if (retrievalSuccess) break;

      try {
        console.log(`[RAG] Probando collection_name: ${collectionName}`);

        const retrievalResponse = await fetch(`${OPENWEBUI_URL}/api/v1/retrieval/query`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            collection_names: [collectionName],
            query: query,
            k: topK
          })
        });

        if (retrievalResponse.ok) {
          const retrievalData = await retrievalResponse.json();
          const documents = retrievalData.documents || retrievalData.results || [];

          if (documents.length > 0) {
            chunks = documents.map((doc, index) => ({
              content: typeof doc === 'string' ? doc : (doc.content || doc.text || doc.page_content || JSON.stringify(doc)),
              metadata: typeof doc === 'object' ? (doc.metadata || {}) : {},
              score: doc.score || doc.distance || null,
              source: 'vector_search',
              collectionName: collectionName,
              index: index
            }));
            retrievalSuccess = true;
            usedMethod = 'vector_retrieval';
            console.log(`[RAG] Retrieval exitoso con ${collectionName}: ${chunks.length} documentos`);
          } else {
            console.log(`[RAG] Collection ${collectionName}: respuesta OK pero 0 documentos`);
          }
        } else {
          console.log(`[RAG] Collection ${collectionName}: error ${retrievalResponse.status}`);
        }
      } catch (err) {
        console.log(`[RAG] Collection ${collectionName}: excepción - ${err.message}`);
      }
    }

    // Estrategia 2: Si no hay resultados vectoriales, obtener contenido de archivos de la KB
    if (!retrievalSuccess || chunks.length === 0) {
      console.log(`[RAG] Retrieval vectorial sin resultados, obteniendo archivos de KB...`);

      try {
        const kbResponse = await fetch(`${OPENWEBUI_URL}/api/v1/knowledge/${kbId}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        if (kbResponse.ok) {
          const kbData = await kbResponse.json();
          console.log(`[RAG] KB ${kbData.name}: ${kbData.files?.length || 0} archivos`);

          if (kbData.files && kbData.files.length > 0) {
            for (const file of kbData.files.slice(0, 5)) {
              try {
                const fileId = file.id || file.file_id;
                console.log(`[RAG] Obteniendo archivo de KB: ${fileId}`);

                const fileResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/${fileId}`, {
                  headers: { 'Authorization': `Bearer ${apiKey}` }
                });

                if (fileResponse.ok) {
                  const fileData = await fileResponse.json();
                  console.log(`[RAG] Archivo ${fileId}: data.content = ${fileData.data?.content ? 'SI' : 'NO'} (${fileData.data?.content?.length || 0} chars)`);

                  if (fileData.data && fileData.data.content) {
                    const content = fileData.data.content;
                    const chunkSize = 1500;

                    if (content.length <= chunkSize) {
                      chunks.push({
                        content: content,
                        filename: fileData.filename || file.filename || 'unknown',
                        fileId: fileId,
                        source: 'file_content',
                        chunkIndex: 0
                      });
                    } else {
                      const maxChunks = Math.min(Math.ceil(content.length / chunkSize), topK);
                      for (let i = 0; i < maxChunks; i++) {
                        chunks.push({
                          content: content.substring(i * chunkSize, (i + 1) * chunkSize),
                          filename: fileData.filename || file.filename || 'unknown',
                          fileId: fileId,
                          source: 'file_content',
                          chunkIndex: i
                        });
                      }
                    }
                    usedMethod = 'file_content';
                  }
                }
              } catch (err) {
                console.warn(`[RAG] Error procesando archivo de KB:`, err.message);
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[RAG] Error obteniendo KB:`, err.message);
      }
    }

    // Estrategia 3: Si la KB está vacía, buscar en TODOS los archivos de Open WebUI
    if (chunks.length === 0) {
      console.log(`[RAG] KB vacía, buscando en todos los archivos de Open WebUI...`);

      try {
        const filesResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        if (filesResponse.ok) {
          const allFiles = await filesResponse.json();
          console.log(`[RAG] Total archivos en Open WebUI: ${allFiles.length}`);

          // Ordenar por fecha de creación (más recientes primero) y tomar los primeros 5
          const sortedFiles = allFiles
            .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
            .slice(0, 5);

          for (const file of sortedFiles) {
            try {
              const fileId = file.id;
              console.log(`[RAG] Obteniendo archivo global: ${fileId} (${file.filename || file.meta?.name || 'unknown'})`);

              const fileResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/${fileId}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
              });

              if (fileResponse.ok) {
                const fileData = await fileResponse.json();
                console.log(`[RAG] Archivo ${fileId}: data.content = ${fileData.data?.content ? 'SI' : 'NO'} (${fileData.data?.content?.length || 0} chars)`);

                if (fileData.data && fileData.data.content) {
                  const content = fileData.data.content;
                  const chunkSize = 1500;

                  if (content.length <= chunkSize) {
                    chunks.push({
                      content: content,
                      filename: fileData.filename || file.filename || file.meta?.name || 'unknown',
                      fileId: fileId,
                      source: 'all_files',
                      chunkIndex: 0
                    });
                  } else {
                    const maxChunks = Math.min(Math.ceil(content.length / chunkSize), topK);
                    for (let i = 0; i < maxChunks; i++) {
                      chunks.push({
                        content: content.substring(i * chunkSize, (i + 1) * chunkSize),
                        filename: fileData.filename || file.filename || file.meta?.name || 'unknown',
                        fileId: fileId,
                        source: 'all_files',
                        chunkIndex: i
                      });
                    }
                  }
                  usedMethod = 'all_files_fallback';

                  // Si ya tenemos suficientes chunks, salir
                  if (chunks.length >= topK) break;
                }
              }
            } catch (err) {
              console.warn(`[RAG] Error procesando archivo global:`, err.message);
            }
          }
        }
      } catch (err) {
        console.warn(`[RAG] Error obteniendo archivos globales:`, err.message);
      }
    }

    console.log(`[RAG] Resultado final: ${chunks.length} chunks (método: ${usedMethod})`);

    res.json({
      success: true,
      method: usedMethod,
      query: query,
      chunks: chunks,
      knowledgeBaseId: kbId,
      totalChunks: chunks.length
    });

  } catch (error) {
    console.error('[RAG] Retrieve-only error:', error.message);
    res.status(500).json({
      error: 'Error en retrieval',
      message: error.message
    });
  }
});

/**
 * Lista Knowledge Bases disponibles
 * GET /list-knowledge-bases
 */
app.get('/list-knowledge-bases', async (req, res) => {
  try {
    const apiKey = getApiKey(req.query.apiKey);

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key not configured' });
    }

    const response = await fetch(`${OPENWEBUI_URL}/api/v1/knowledge/`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Error listando knowledge bases: ${response.status}`);
    }

    const knowledgeBases = await response.json();
    console.log(`[RAG] ${knowledgeBases.length || 0} knowledge bases encontradas`);

    res.json({
      success: true,
      knowledgeBases,
      configuredKnowledgeId: OPENWEBUI_KNOWLEDGE_ID || null,
      openwebuiUrl: OPENWEBUI_URL
    });

  } catch (error) {
    console.error('[RAG] List KB error:', error.message);
    res.status(500).json({
      error: 'Error listando knowledge bases',
      message: error.message
    });
  }
});

/**
 * Lista archivos en Open WebUI
 * GET /list-rag-files
 */
app.get('/list-rag-files', async (req, res) => {
  try {
    const apiKey = getApiKey(req.query.apiKey);

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key not configured' });
    }

    const response = await fetch(`${OPENWEBUI_URL}/api/v1/files/`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Error listando archivos: ${response.status}`);
    }

    const files = await response.json();
    console.log(`[RAG] ${files.length || 0} archivos encontrados`);

    res.json({
      success: true,
      files,
      openwebuiUrl: OPENWEBUI_URL
    });

  } catch (error) {
    console.error('[RAG] List error:', error.message);
    res.status(500).json({
      error: 'Error listando archivos',
      message: error.message
    });
  }
});


// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[SHUTDOWN] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log(`SearXNG Proxy v${VERSION} (${BUILD_DATE})`);
  console.log(`Running on port ${PORT}`);
  console.log(`Proxying to: ${SEARXNG_URL}`);
  console.log(`Open WebUI RAG: ${OPENWEBUI_URL}`);
  console.log(`API Key configured: ${OPENWEBUI_API_KEY ? 'Yes' : 'No'}`);
  console.log(`Knowledge Base ID: ${OPENWEBUI_KNOWLEDGE_ID || 'Not configured'}`);
  console.log(`Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB used`);
  console.log('========================================');
});

// Handle server errors
server.on('error', (error) => {
  console.error('[SERVER ERROR]:', error.message);
});
