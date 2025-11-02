// Importar librerías con require()
const express = require("express");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");
const cors = require("cors");
const { auth } = require('express-oauth2-jwt-bearer');

// Cargar variables del .env
dotenv.config();

// Crear app express
const app = express();
app.use(cors());
app.use(express.json());

// Middleware de autenticación de Auth0
const checkJwt = auth({
  audience: 'https://dev-7iloabq8ips3sdq0.us.auth0.com/api/v2/',
  issuerBaseURL: 'https://dev-7iloabq8ips3sdq0.us.auth0.com/',
  tokenSigningAlg: 'RS256'
});

// Conexión a MySQL con promises
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  port: process.env.DB_PORT,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

// Verificar conexión
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log("✅ Conectado a la base de datos MySQL:", process.env.DB_NAME);
    connection.release();
  } catch (err) {
    console.error("❌ Error al conectar a MySQL:", err);
  }
})();

// Ruta de prueba
app.get("/", (req, res) => {
  res.send("Servidor funcionando y conectado a MySQL");
});

app.get("/test-db", async (req, res) => {
  try {
    const [results] = await pool.query("SHOW TABLES");
    res.json(results);
  } catch (err) {
    console.error("Error al consultar:", err);
    res.status(500).send("Error al acceder a la base de datos");
  }
});

// ====================
// RUTAS DE PERFIL
// ====================

// 1. Obtener el rol del usuario autenticado
app.get("/api/profile/get-role", checkJwt, async (req, res) => {
  try {
    // El auth0Id viene en el token JWT como "sub"
    const auth0Id = req.auth.payload.sub;
    
    // Buscar o crear el usuario en usuario_auth0
    let [userRows] = await pool.query(
      "SELECT ID_Usuario, Rol FROM usuario_auth0 WHERE Auth0_ID = ?",
      [auth0Id]
    );

    let userId, userRole;
    
    if (userRows.length === 0) {
      // Si no existe, crear el usuario sin rol asignado
      const [result] = await pool.query(
        "INSERT INTO usuario_auth0 (Auth0_ID, Rol) VALUES (?, 'no_profile')",
        [auth0Id]
      );
      userId = result.insertId;
      userRole = 'no_profile';
    } else {
      userId = userRows[0].ID_Usuario;
      userRole = userRows[0].Rol;
    }

    // Si el rol es 'no_profile', devolver directamente
    if (userRole === 'no_profile') {
      return res.json({
        role: 'no_profile',
        auth0Id: auth0Id,
        id_usuario: userId
      });
    }

    // Si tiene rol asignado, buscar sus datos completos
    if (userRole === 'Medico') {
      const [medicoRows] = await pool.query(
        "SELECT ID_Medico, Nombre, Apellidos, Correo FROM medico WHERE ID_Usuario_Auth = ?",
        [userId]
      );

      if (medicoRows.length > 0) {
        return res.json({
          role: 'Medico',
          id_user: medicoRows[0].ID_Medico,
          id_usuario: userId,
          auth0Id: auth0Id,
          nombre: medicoRows[0].Nombre,
          apellidos: medicoRows[0].Apellidos,
          correo: medicoRows[0].Correo
        });
      }
    }

    if (userRole === 'Paciente') {
      const [pacienteRows] = await pool.query(
        "SELECT ID_Paciente, Nombre, Correo FROM paciente WHERE ID_Usuario_Auth = ?",
        [userId]
      );

      if (pacienteRows.length > 0) {
        return res.json({
          role: 'Paciente',
          id_user: pacienteRows[0].ID_Paciente,
          id_usuario: userId,
          auth0Id: auth0Id,
          nombre: pacienteRows[0].Nombre,
          correo: pacienteRows[0].Correo
        });
      }
    }

    // Si tiene rol pero no tiene datos en las tablas, es inconsistente
    res.json({
      role: 'no_profile',
      auth0Id: auth0Id,
      id_usuario: userId
    });

  } catch (error) {
    console.error("Error en get-role:", error);
    res.status(500).json({ error: "Error al obtener el rol del usuario" });
  }
});

// 2. Registrar perfil (Onboarding)
app.post("/api/profile/register", checkJwt, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const auth0Id = req.auth.payload.sub;
    const { rol, data } = req.body;

    // Validar que el rol sea válido
    if (rol !== 'Medico' && rol !== 'Paciente') {
      return res.status(400).json({ error: "Rol no válido" });
    }

    // Iniciar transacción
    await connection.beginTransaction();

    // Obtener el ID_Usuario
    const [userRows] = await connection.query(
      "SELECT ID_Usuario FROM usuario_auth0 WHERE Auth0_ID = ?",
      [auth0Id]
    );

    if (userRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const userId = userRows[0].ID_Usuario;

    if (rol === 'Medico') {
      // Insertar en tabla medico
      await connection.query(
        `INSERT INTO medico 
        (Nombre, Apellidos, Telefono, Correo, Cedula, Experiencia, ID_Usuario_Auth) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          data.nombre,
          data.apellidos,
          data.telefono,
          data.correo,
          data.cedula,
          data.experiencia,
          userId
        ]
      );

      // Actualizar el rol en usuario_auth0
      await connection.query(
        "UPDATE usuario_auth0 SET Rol = 'Medico' WHERE ID_Usuario = ?",
        [userId]
      );

      await connection.commit();
      return res.json({ message: "Perfil de médico registrado exitosamente", role: 'Medico' });
    } 
    
    if (rol === 'Paciente') {
      // Insertar en tabla paciente
      await connection.query(
        `INSERT INTO paciente 
        (Nombre, Sexo, FechaNacimiento, Direccion, Codigo_Postal, Ciudad, 
         Ocupacion, Telefono, Correo, ID_Usuario_Auth) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.nombre,
          data.sexo,
          data.fechaNacimiento,
          data.direccion,
          data.codigoPostal,
          data.ciudad,
          data.ocupacion,
          data.telefono,
          data.correo,
          userId
        ]
      );

      // Actualizar el rol en usuario_auth0
      await connection.query(
        "UPDATE usuario_auth0 SET Rol = 'Paciente' WHERE ID_Usuario = ?",
        [userId]
      );

      await connection.commit();
      return res.json({ message: "Perfil de paciente registrado exitosamente", role: 'Paciente' });
    }

  } catch (error) {
    await connection.rollback();
    console.error("Error en register:", error);
    res.status(500).json({ error: "Error al registrar el perfil" });
  } finally {
    connection.release();
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});