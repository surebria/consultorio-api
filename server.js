// Importar librerías con require()
const express = require("express");
const dotenv = require("dotenv");
const mysql = require("mysql2");
const cors = require("cors");

// Cargar variables del .env
dotenv.config();

// Crear app express
const app = express();
app.use(cors());
app.use(express.json());

// Conexión a MySQL
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  port: process.env.DB_PORT,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

// Verificar conexión
db.connect(err => {
  if (err) {
    console.error("❌ Error al conectar a MySQL:", err);
  } else {
    console.log("✅ Conectado a la base de datos MySQL:", process.env.DB_NAME);
  }
});

// Ruta de prueba
app.get("/", (req, res) => {
  res.send("Servidor funcionando y conectado a MySQL");
});

app.get("/test-db", (req, res) => {
    db.query("SHOW TABLES", (err, results) => {
      if (err) {
        console.error("Error al consultar:", err);
        res.status(500).send("Error al acceder a la base de datos");
      } else {
        res.json(results);
      }
    });
  });
  

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});
