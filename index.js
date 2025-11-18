// index.js
import express from "express";
import cors from "cors";
import { google } from "googleapis";
import multer from "multer";
import fs from "fs";

const app = express();
app.use(express.json());
app.use(cors());

const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;

if (!GOOGLE_CREDENTIALS) {
  console.error("❌ ERROR: Falta la variable GOOGLE_CREDENTIALS");
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_CREDENTIALS),
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
  ],
});


// Multer (archivo temporal)
const upload = multer({ dest: "temp/" });

/* ============================================================
📌 LEER GOOGLE SHEETS
============================================================ */
async function readSheet(spreadsheetId, sheetName) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
  });

  const rows = response.data.values || [];
  if (!rows.length) return [];

  const headers = rows[0];
  return rows.slice(1).map((row) => {
    let obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] || ""));
    return obj;
  });
}

/* ============================================================
📌 OBTENER O CREAR CARPETA
============================================================ */
async function getOrCreateFolder(drive, name, parentId) {
  const query = `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const res = await drive.files.list({
    q: query,
    fields: "files(id, name)",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: "allDrives",
  });

  if (res.data.files.length > 0) return res.data.files[0].id;

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  return folder.data.id;
}

/* ============================================================
📌 RUTAS COMUNES (UT Viviendas 2025)
============================================================ */
const UT_SPREADSHEET_ID = "1qFkHtTXy3bv_eswbVnVyCDSQ6QN3bsZMiZ3mTx_s2S4";
const UT_SHEET_NAME = "Copia de Casas 1";
const SHARED_FOLDER_ID = "15Jh_jvxDzcj70ueqmwVk2oAJGRzctGob";

app.get("/barrios", async (req, res) => {
  const data = await readSheet(UT_SPREADSHEET_ID, UT_SHEET_NAME);
  const barrios = [...new Set(data.map((v) => v["BARRIO"]).filter(Boolean))];
  res.json(barrios);
});

app.get("/viviendas", async (req, res) => {
  const barrio = req.query.barrio;
  if (!barrio) return res.status(400).json({ error: "Falta parámetro barrio" });
  const data = await readSheet(UT_SPREADSHEET_ID, UT_SHEET_NAME);
  res.json(data.filter((v) => v["BARRIO"] === barrio));
});

app.get("/info-vivienda", async (req, res) => {
  const cedula = req.query.cedula;
  if (!cedula) return res.status(400).json({ error: "Falta parámetro cedula" });
  const data = await readSheet(UT_SPREADSHEET_ID, UT_SHEET_NAME);
  const vivienda = data.find((v) => v["C.C"] === cedula);
  if (!vivienda) return res.status(404).json({ error: "Vivienda no encontrada" });
  res.json(vivienda);
});

/* ============================================================
📌 RUTAS ANTIOQUIA 2025
============================================================ */
const ANT_SPREADSHEET_ID = "1fe3XDNN8n3Av55BSaBn3h7_cgN18XD8toYpvmWPCP2w";
const ANT_SHEET_NAME = "Universo";
const ANT_SHARED_FOLDER_ID = "17jOXbUk_1aCMzKY4zbAScr4P6P7Jjxv0";

app.get("/municipios-antioquia", async (req, res) => {
  try {
    const rows = await readSheet(ANT_SPREADSHEET_ID, ANT_SHEET_NAME);
    const municipios = [...new Set(
      rows.map(r => r["MUNICIPIO"]).filter(v => v && v.trim() !== "")
    )];
    res.json(municipios);
  } catch (e) {
    res.status(500).json({ error: "No se pudieron obtener los municipios", detalle: e.message });
  }
});

app.get("/viviendas-antioquia", async (req, res) => {
  const municipio = req.query.municipio;
  if (!municipio) return res.status(400).json({ error: "Falta parámetro municipio" });

  try {
    const rows = await readSheet(ANT_SPREADSHEET_ID, ANT_SHEET_NAME);
    const viviendas = rows.filter(r => r["MUNICIPIO"] === municipio);
    res.json(viviendas);
  } catch (e) {
    res.status(500).json({ error: "No se pudieron obtener las viviendas", detalle: e.message });
  }
});

app.get("/info-vivienda-antioquia", async (req, res) => {
  const cedula = req.query.cedula;
  if (!cedula) return res.status(400).json({ error: "Falta parámetro cedula" });

  try {
    const rows = await readSheet(ANT_SPREADSHEET_ID, ANT_SHEET_NAME);
    const vivienda = rows.find(r => r["DOCUMENTO DE IDENTIDAD"] === cedula);
    if (!vivienda) return res.status(404).json({ error: "Vivienda no encontrada" });
    res.json(vivienda);
  } catch (e) {
    res.status(500).json({ error: "No se pudo obtener la vivienda", detalle: e.message });
  }
});

/* ============================================================
📌 SUBIR FOTO A DRIVE (compatible UT y Antioquia)
============================================================ */
app.post("/upload", upload.single("foto"), async (req, res) => {
  try {
    const { vivienda, sector, tipo, nombre, proyecto, zonaIntervencion } = req.body;
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo" });
    if (!sector || !vivienda || !nombre || !tipo)
      return res.status(400).json({ error: "Faltan datos obligatorios" });

    const filePath = req.file.path;
    const fileName = `${tipo}_${req.file.originalname}`;

    const client = await auth.getClient();
    const drive = google.drive({ version: "v3", auth: client });

    // Carpeta principal según proyecto
    const mainFolderId = proyecto === "Antioquia2025" ? ANT_SHARED_FOLDER_ID : SHARED_FOLDER_ID;

    // 1️⃣ Carpeta del municipio/barrio
    const sectorFolderId = await getOrCreateFolder(drive, sector, mainFolderId);

    // 2️⃣ Carpeta Rural/Urbana para Antioquia
    let zonaFolderId = sectorFolderId;
    if (proyecto === "Antioquia2025") {
      const zonaName = zonaIntervencion && zonaIntervencion.trim() !== ""? zonaIntervencion.toUpperCase() : "URBANA"; // default
      zonaFolderId = await getOrCreateFolder(drive, zonaName, sectorFolderId);


    }

    // 3️⃣ Carpeta del beneficiario
    const beneficiarioFolderId = await getOrCreateFolder(
      drive,
      `${nombre} - ${vivienda}`,
      zonaFolderId
    );

    // 4️⃣ Carpeta del tipo (Antes/Durante/Después)
    const tipoFolderId = await getOrCreateFolder(drive, tipo, beneficiarioFolderId);

    // 5️⃣ Subir archivo
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [tipoFolderId],
      },
      media: {
        mimeType: "image/jpeg",
        body: fs.createReadStream(filePath),
      },
      supportsAllDrives: true,
      fields: "id, webViewLink, webContentLink",
    });

    fs.unlinkSync(filePath);

    res.json({
      mensaje: "Foto subida correctamente",
      fileId: response.data.id,
      link: response.data.webViewLink,
    });
  } catch (error) {
    console.error("❌ ERROR SUBIENDO FOTO:", error.response?.data || error.message);
    res.status(500).json({
      error: "No se pudo subir la foto",
      detalle: error.response?.data || error.message,
    });
  }
});

/* ============================================================
📡 INICIAR SERVIDOR
============================================================ */
app.listen(3000, () =>
  console.log("🚀 Backend corriendo en http://localhost:3000")
);
