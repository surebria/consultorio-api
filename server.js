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

// server.js (Añadir al final del archivo o en una nueva sección de RUTAS DE SERVICIOS)

// ====================
// RUTAS DE SERVICIOS
// ====================

// GET /api/servicios
// Devuelve la lista completa de servicios.
app.get("/api/servicios", async (req, res) => { 
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query(
        "SELECT ID_Servicio, Nombre, Descripcion, Duracion, Costo FROM servicio"
      );
      res.json(rows);
    } catch (error) {
      console.error("Error en /api/servicios:", error);
      res.status(500).json({ error: "Error al obtener la lista de servicios" });
    } finally {
      connection.release();
    }
  });

  app.get("/api/citas/disponibilidad/:id_servicio/:fecha", async (req, res) => {
    const { id_servicio, fecha } = req.params;
    
    const connection = await pool.getConnection();
    try {
      // Obtener las horas ya ocupadas para ese servicio y fecha
      const [citasOcupadas] = await connection.query(
        "SELECT TIME_FORMAT(Hora, '%H:%i') as hora FROM cita WHERE ID_Servicio = ? AND Fecha = ?",
        [id_servicio, fecha]
      );
  
      // Devolver las horas ocupadas (el frontend se encarga de filtrar las disponibles)
      res.json({ horas_ocupadas: citasOcupadas });
    } catch (error) {
      console.error("Error en /api/citas/disponibilidad:", error);
      res.status(500).json({ error: "Error al obtener la disponibilidad" });
    } finally {
      connection.release();
    }
  });
  // server.js (Reemplazar la ruta POST /api/citas/agendar)

// ====================
// RUTAS DE CITAS
// ====================
// server.js (Versión de PRUEBA TEMPORAL - SIN SEGURIDAD JWT)

// POST /api/citas/agendar
// *** ¡¡ADVERTENCIA!! RUTA DESPROTEGIDA PARA PRUEBAS LOCALES ***
app.post("/api/citas/agendar", async (req, res) => {
    const connection = await pool.getConnection();
    
    try {
      // 1. ASIGNACIÓN FIJA DEL PACIENTE PARA PRUEBAS (DEBE SER REEMPLAZADO POR JWT)
      // Asumimos que ID_Paciente = 1 es un paciente de prueba existente.
      const id_paciente = 1; 
  
      const { fecha, hora, id_servicio, notas } = req.body;
      
      // 2. Lógica de Asignación de Médico (Asigna al primer médico disponible)
      const [medicos] = await connection.query(
          "SELECT ID_Medico FROM medico ORDER BY ID_Medico ASC LIMIT 1" 
      );
      if (medicos.length === 0) {
          return res.status(500).json({ error: "No hay médicos disponibles para asignar." });
      }
      const id_medico_asignado = medicos[0].ID_Medico;
  
      // 3. Insertar la cita
      const [result] = await connection.query(
        `INSERT INTO cita (Fecha, Hora, Notas, ID_Paciente, ID_Medico, ID_Servicio, Estado) 
         VALUES (?, ?, ?, ?, ?, ?, 'Agendada')`,
        [fecha, hora, notas, id_paciente, id_medico_asignado, id_servicio]
      );
  
      res.json({ 
          message: "Cita agendada exitosamente", 
          id_cita: result.insertId,
          id_medico_asignado: id_medico_asignado 
      });
  
    } catch (error) {
      console.error("Error en /api/citas/agendar (TEMP):", error);
      res.status(500).json({ error: "Error al agendar la cita" });
    } finally {
      connection.release();
    }
  });

  // ===========================================
// RUTAS DE CITAS - GESTIÓN DE PACIENTES
// ===========================================

// Función auxiliar para obtener el ID de Paciente (Necesaria para proteger las rutas)
async function getPacienteId(pool, auth0Id) {
    // 1. Obtener el ID_Usuario interno
    const [userRows] = await pool.query(
      "SELECT ID_Usuario FROM usuario_auth0 WHERE Auth0_ID = ?",
      [auth0Id]
    );
    if (userRows.length === 0) return null;
  
    const userId = userRows[0].ID_Usuario;
  
    // 2. Obtener el ID_Paciente asociado
    const [pacienteRows] = await pool.query(
      "SELECT ID_Paciente FROM paciente WHERE ID_Usuario_Auth = ?",
      [userId]
    );
  
    return pacienteRows.length > 0 ? pacienteRows[0].ID_Paciente : null;
  }
  app.get("/api/citas/mis-citas", async (req, res) => {
    try {
      // Leer el ID_Paciente directamente del query parameter
      const idPaciente = req.query.idPaciente; 

      // Validar que el ID_Paciente esté presente
      if (!idPaciente) {
        // Devolvemos 400 Bad Request si el parámetro necesario falta
        return res.status(400).json({ error: "Falta el ID_Paciente. Debe ser enviado como query parameter (ej: /mis-citas?idPaciente=456)." });
      }

      // Convertir el ID a número si es necesario para tu consulta SQL
      const pacienteIdNum = parseInt(idPaciente, 10);
      if (isNaN(pacienteIdNum)) {
         return res.status(400).json({ error: "El ID_Paciente debe ser un número válido." });
      }


      const [citas] = await pool.query(
        `SELECT 
          c.ID_Cita, 
          c.Fecha_Cita, 
          c.Hora_Cita, 
          c.Estado, 
          s.Nombre AS Servicio,
          m.Nombre AS Nombre_Medico,
          m.Apellidos AS Apellidos_Medico
        FROM cita c
        JOIN servicio s ON c.ID_Servicio = s.ID_Servicio
        LEFT JOIN medico m ON c.ID_Medico_Asignado = m.ID_Medico
        WHERE c.ID_Paciente = ?
        ORDER BY c.Fecha_Cita DESC, c.Hora_Cita DESC`,
        [pacienteIdNum]
      );

      res.json(citas);
    } catch (error) {
      console.error("Error al obtener mis citas:", error);
      res.status(500).json({ error: "Error interno al cargar las citas." });
    }
});


// 2. Cancelar una cita con restricción de 7 días
// RUTA: /api/citas/cancelar/:idCita
// Espera el ID del paciente en el cuerpo del request para verificar propiedad
app.post("/api/citas/cancelar/:idCita", async (req, res) => {
    const connection = await pool.getConnection();

    try {
      // Para POST/PUT, es común leer la identificación desde el cuerpo
      const idPaciente = req.body.idPaciente; 
      const idCita = req.params.idCita;

      if (!idPaciente) {
        return res.status(400).json({ error: "Falta el ID_Paciente en el cuerpo de la solicitud." });
      }
      
      const pacienteIdNum = parseInt(idPaciente, 10);
      if (isNaN(pacienteIdNum)) {
         return res.status(400).json({ error: "El ID_Paciente debe ser un número válido." });
      }


      // 1. Verificar si la cita existe, pertenece al paciente y obtener la fecha
      const [citaRows] = await connection.query(
        "SELECT Fecha_Cita, Estado FROM cita WHERE ID_Cita = ? AND ID_Paciente = ?",
        [idCita, pacienteIdNum]
      );

      if (citaRows.length === 0) {
        return res.status(404).json({ error: "Cita no encontrada o no pertenece al usuario." });
      }
      
      if (citaRows[0].Estado === 'Cancelada') {
          return res.status(400).json({ error: "La cita ya está cancelada." });
      }

      // 2. Aplicar la restricción de 7 días (1 semana)
      const fechaCita = new Date(citaRows[0].Fecha_Cita);
      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0); 
      
      const diffTime = fechaCita.getTime() - hoy.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

      if (diffDays <= 7) {
        return res.status(400).json({ 
          error: `No se puede cancelar. La cita es en ${diffDays} días o menos. La cancelación solo es permitida con más de 7 días de antelación.` 
        });
      }

      // 3. Cancelar la cita
      await connection.query(
        "UPDATE cita SET Estado = 'Cancelada' WHERE ID_Cita = ?",
        [idCita]
      );

      await connection.commit();
      res.json({ message: "Cita cancelada exitosamente." });

    } catch (error) {
      await connection.rollback();
      console.error("Error al cancelar cita:", error);
      res.status(500).json({ error: "Error interno al cancelar la cita." });
    } finally {
      connection.release();
    }
});
// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});