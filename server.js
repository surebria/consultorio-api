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
/*app.post("/api/citas/agendar", async (req, res) => {
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
*/
  // ====================
// RUTAS DE CITAS - AÑADIR AL server.js
// ====================

// GET /api/citas/mis-citas
// Obtiene todas las citas del paciente autenticado
app.get("/api/citas/mis-citas", checkJwt, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const auth0Id = req.auth.payload.sub;
    
    // 1. Obtener el ID_Usuario de Auth0
    const [userRows] = await connection.query(
      "SELECT ID_Usuario FROM usuario_auth0 WHERE Auth0_ID = ?",
      [auth0Id]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const userId = userRows[0].ID_Usuario;

    // 2. Obtener el ID_Paciente
    const [pacienteRows] = await connection.query(
      "SELECT ID_Paciente FROM paciente WHERE ID_Usuario_Auth = ?",
      [userId]
    );

    if (pacienteRows.length === 0) {
      return res.status(404).json({ error: "Perfil de paciente no encontrado" });
    }

    const idPaciente = pacienteRows[0].ID_Paciente;

    // 3. Obtener todas las citas del paciente con información relacionada
    const [citas] = await connection.query(
      `SELECT 
        c.ID_Cita,
        c.Fecha AS Fecha_Cita,
        c.Hora AS Hora_Cita,
        c.Estado,
        c.Notas,
        s.Nombre AS Servicio,
        m.Nombre AS Nombre_Medico,
        m.Apellidos AS Apellidos_Medico
      FROM cita c
      INNER JOIN servicio s ON c.ID_Servicio = s.ID_Servicio
      INNER JOIN medico m ON c.ID_Medico = m.ID_Medico
      WHERE c.ID_Paciente = ?
      ORDER BY c.Fecha DESC, c.Hora DESC`,
      [idPaciente]
    );

    res.json(citas);

  } catch (error) {
    console.error("Error en /api/citas/mis-citas:", error);
    res.status(500).json({ error: "Error al obtener las citas del paciente" });
  } finally {
    connection.release();
  }
});

// POST /api/citas/cancelar/:id_cita
// Cancela una cita del paciente autenticado
app.post("/api/citas/cancelar/:id_cita", checkJwt, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const auth0Id = req.auth.payload.sub;
    const idCita = req.params.id_cita;

    // 1. Obtener el ID_Usuario de Auth0
    const [userRows] = await connection.query(
      "SELECT ID_Usuario FROM usuario_auth0 WHERE Auth0_ID = ?",
      [auth0Id]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const userId = userRows[0].ID_Usuario;

    // 2. Obtener el ID_Paciente
    const [pacienteRows] = await connection.query(
      "SELECT ID_Paciente FROM paciente WHERE ID_Usuario_Auth = ?",
      [userId]
    );

    if (pacienteRows.length === 0) {
      return res.status(404).json({ error: "Perfil de paciente no encontrado" });
    }

    const idPaciente = pacienteRows[0].ID_Paciente;

    // 3. Verificar que la cita pertenece al paciente y obtener su fecha
    const [citaRows] = await connection.query(
      "SELECT ID_Cita, Fecha, Estado FROM cita WHERE ID_Cita = ? AND ID_Paciente = ?",
      [idCita, idPaciente]
    );

    if (citaRows.length === 0) {
      return res.status(404).json({ error: "Cita no encontrada o no pertenece a este paciente" });
    }

    const cita = citaRows[0];

    // 4. Verificar que la cita no esté ya cancelada
    if (cita.Estado === 'Cancelada') {
      return res.status(400).json({ error: "Esta cita ya está cancelada" });
    }

    // 5. Verificar que la cancelación se hace con más de 7 días de anticipación
    const fechaCita = new Date(cita.Fecha);
    fechaCita.setHours(0, 0, 0, 0);
    
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    
    const diffTime = fechaCita.getTime() - hoy.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays <= 7) {
      return res.status(400).json({ 
        error: "No se puede cancelar la cita. Debe cancelarse con más de 7 días de anticipación." 
      });
    }

    // 6. Actualizar el estado de la cita a 'Cancelada'
    await connection.query(
      "UPDATE cita SET Estado = 'Cancelada' WHERE ID_Cita = ?",
      [idCita]
    );

    res.json({ 
      message: "Cita cancelada exitosamente",
      id_cita: idCita 
    });

  } catch (error) {
    console.error("Error en /api/citas/cancelar:", error);
    res.status(500).json({ error: "Error al cancelar la cita" });
  } finally {
    connection.release();
  }
});
/*
// POST /api/citas/agendar (Versión con JWT - REEMPLAZAR la versión actual)
app.post("/api/citas/agendar", checkJwt, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const auth0Id = req.auth.payload.sub;
    const { fecha, hora, id_servicio, notas } = req.body;

    // 1. Obtener el ID_Usuario de Auth0
    const [userRows] = await connection.query(
      "SELECT ID_Usuario FROM usuario_auth0 WHERE Auth0_ID = ?",
      [auth0Id]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const userId = userRows[0].ID_Usuario;

    // 2. Obtener el ID_Paciente
    const [pacienteRows] = await connection.query(
      "SELECT ID_Paciente FROM paciente WHERE ID_Usuario_Auth = ?",
      [userId]
    );

    if (pacienteRows.length === 0) {
      return res.status(404).json({ error: "Perfil de paciente no encontrado. Por favor, complete su perfil primero." });
    }

    const idPaciente = pacienteRows[0].ID_Paciente;

    // 3. Verificar que el horario esté disponible
    const [citasExistentes] = await connection.query(
      "SELECT ID_Cita FROM cita WHERE ID_Servicio = ? AND Fecha = ? AND Hora = ? AND Estado != 'Cancelada'",
      [id_servicio, fecha, hora]
    );

    if (citasExistentes.length > 0) {
      return res.status(400).json({ error: "Este horario ya no está disponible" });
    }

    // 4. Asignar un médico (primer médico disponible - puedes mejorar esta lógica)
    const [medicos] = await connection.query(
      "SELECT ID_Medico FROM medico ORDER BY ID_Medico ASC LIMIT 1"
    );

    if (medicos.length === 0) {
      return res.status(500).json({ error: "No hay médicos disponibles para asignar" });
    }

    const idMedicoAsignado = medicos[0].ID_Medico;

    // 5. Insertar la cita
    const [result] = await connection.query(
      `INSERT INTO cita (Fecha, Hora, Notas, ID_Paciente, ID_Medico, ID_Servicio, Estado) 
       VALUES (?, ?, ?, ?, ?, ?, 'Agendada')`,
      [fecha, hora, notas, idPaciente, idMedicoAsignado, id_servicio]
    );

    res.json({ 
      message: "Cita agendada exitosamente",
      id_cita: result.insertId,
      id_medico_asignado: idMedicoAsignado
    });

  } catch (error) {
    console.error("Error en /api/citas/agendar:", error);
    res.status(500).json({ error: "Error al agendar la cita" });
  } finally {
    connection.release();
  }
});*/

app.post("/api/citas/agendar", checkJwt, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const auth0Id = req.auth.payload.sub;
    const { fecha, hora, id_servicio, notas } = req.body;

    // 1. Obtener el ID_Usuario de Auth0
    const [userRows] = await connection.query(
      "SELECT ID_Usuario FROM usuario_auth0 WHERE Auth0_ID = ?",
      [auth0Id]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const userId = userRows[0].ID_Usuario;

    // 2. Obtener el ID_Paciente
    const [pacienteRows] = await connection.query(
      "SELECT ID_Paciente FROM paciente WHERE ID_Usuario_Auth = ?",
      [userId]
    );

    if (pacienteRows.length === 0) {
      return res.status(404).json({ error: "Perfil de paciente no encontrado. Por favor, complete su perfil primero." });
    }

    const idPaciente = pacienteRows[0].ID_Paciente;

    // 3. Verificar que el horario esté disponible
    const [citasExistentes] = await connection.query(
      "SELECT ID_Cita FROM cita WHERE ID_Servicio = ? AND Fecha = ? AND Hora = ? AND Estado != 'Cancelada'",
      [id_servicio, fecha, hora]
    );

    if (citasExistentes.length > 0) {
      return res.status(400).json({ error: "Este horario ya no está disponible" });
    }

    // 🔹 4. Insertar la cita sin asignar médico (ID_Medico = NULL)
    const [result] = await connection.query(
      `INSERT INTO cita (Fecha, Hora, Notas, ID_Paciente, ID_Medico, ID_Servicio, Estado) 
       VALUES (?, ?, ?, ?, NULL, ?, 'Agendada')`,
      [fecha, hora, notas, idPaciente, id_servicio]
    );

    res.json({ 
      message: "Cita agendada exitosamente (sin médico asignado)",
      id_cita: result.insertId
    });

  } catch (error) {
    console.error("Error en /api/citas/agendar:", error);
    res.status(500).json({ error: "Error al agendar la cita" });
  } finally {
    connection.release();
  }
});

// ====================
// RUTAS DE CITAS PARA MÉDICOS
// ====================

// GET /api/citas/pendientes
// Obtiene todas las citas pendientes sin médico asignado, agrupadas por servicio
app.get("/api/citas/pendientes", checkJwt, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const auth0Id = req.auth.payload.sub;
    
    // 1. Verificar que el usuario es médico
    const [userRows] = await connection.query(
      "SELECT ID_Usuario, Rol FROM usuario_auth0 WHERE Auth0_ID = ?",
      [auth0Id]
    );

    if (userRows.length === 0 || userRows[0].Rol !== 'Medico') {
      return res.status(403).json({ error: "Acceso denegado. Solo médicos pueden acceder." });
    }

    // 2. Obtener todas las citas pendientes sin médico asignado
    const [citas] = await connection.query(
      `SELECT 
        c.ID_Cita,
        c.Fecha,
        c.Hora,
        c.Estado,
        c.Notas,
        c.ID_Servicio,
        s.Nombre AS Servicio,
        s.Descripcion AS Servicio_Descripcion,
        s.Duracion AS Servicio_Duracion,
        p.Nombre AS Paciente_Nombre,
        p.Telefono AS Paciente_Telefono,
        p.Correo AS Paciente_Correo
      FROM cita c
      INNER JOIN servicio s ON c.ID_Servicio = s.ID_Servicio
      INNER JOIN paciente p ON c.ID_Paciente = p.ID_Paciente
      WHERE c.ID_Medico IS NULL 
        AND c.Estado = 'Agendada'
        AND c.Fecha >= CURDATE()
      ORDER BY s.Nombre, c.Fecha, c.Hora`,
      []
    );

    // 3. Agrupar por servicio
    const citasPorServicio = citas.reduce((acc, cita) => {
      const servicioNombre = cita.Servicio;
      if (!acc[servicioNombre]) {
        acc[servicioNombre] = {
          id_servicio: cita.ID_Servicio,
          nombre: servicioNombre,
          descripcion: cita.Servicio_Descripcion,
          duracion: cita.Servicio_Duracion,
          citas: []
        };
      }
      acc[servicioNombre].citas.push({
        id_cita: cita.ID_Cita,
        fecha: cita.Fecha,
        hora: cita.Hora,
        estado: cita.Estado,
        notas: cita.Notas,
        paciente: {
          nombre: cita.Paciente_Nombre,
          telefono: cita.Paciente_Telefono,
          correo: cita.Paciente_Correo
        }
      });
      return acc;
    }, {});

    res.json(Object.values(citasPorServicio));

  } catch (error) {
    console.error("Error en /api/citas/pendientes:", error);
    res.status(500).json({ error: "Error al obtener las citas pendientes" });
  } finally {
    connection.release();
  }
});

// POST /api/citas/aceptar/:id_cita
// Permite al médico aceptar una cita y asignársela
app.post("/api/citas/aceptar/:id_cita", checkJwt, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const auth0Id = req.auth.payload.sub;
    const idCita = req.params.id_cita;

    // 1. Obtener el ID_Usuario de Auth0
    const [userRows] = await connection.query(
      "SELECT ID_Usuario, Rol FROM usuario_auth0 WHERE Auth0_ID = ?",
      [auth0Id]
    );

    if (userRows.length === 0 || userRows[0].Rol !== 'Medico') {
      return res.status(403).json({ error: "Acceso denegado. Solo médicos pueden aceptar citas." });
    }

    const userId = userRows[0].ID_Usuario;

    // 2. Obtener el ID_Medico
    const [medicoRows] = await connection.query(
      "SELECT ID_Medico FROM medico WHERE ID_Usuario_Auth = ?",
      [userId]
    );

    if (medicoRows.length === 0) {
      return res.status(404).json({ error: "Perfil de médico no encontrado" });
    }

    const idMedico = medicoRows[0].ID_Medico;

    // 3. Verificar que la cita existe y no tiene médico asignado
    const [citaRows] = await connection.query(
      "SELECT ID_Cita, ID_Medico, Estado FROM cita WHERE ID_Cita = ?",
      [idCita]
    );

    if (citaRows.length === 0) {
      return res.status(404).json({ error: "Cita no encontrada" });
    }

    const cita = citaRows[0];

    if (cita.ID_Medico !== null) {
      return res.status(400).json({ error: "Esta cita ya tiene un médico asignado" });
    }

    if (cita.Estado === 'Cancelada') {
      return res.status(400).json({ error: "Esta cita está cancelada" });
    }

    // 4. Asignar el médico a la cita
    await connection.query(
      "UPDATE cita SET ID_Medico = ? WHERE ID_Cita = ?",
      [idMedico, idCita]
    );

    res.json({ 
      message: "Cita aceptada exitosamente",
      id_cita: idCita,
      id_medico: idMedico
    });

  } catch (error) {
    console.error("Error en /api/citas/aceptar:", error);
    res.status(500).json({ error: "Error al aceptar la cita" });
  } finally {
    connection.release();
  }
});

// GET /api/citas/mis-citas-medico
// Obtiene todas las citas asignadas al médico autenticado
app.get("/api/citas/mis-citas-medico", checkJwt, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const auth0Id = req.auth.payload.sub;
    
    // 1. Obtener el ID_Usuario de Auth0
    const [userRows] = await connection.query(
      "SELECT ID_Usuario, Rol FROM usuario_auth0 WHERE Auth0_ID = ?",
      [auth0Id]
    );

    if (userRows.length === 0 || userRows[0].Rol !== 'Medico') {
      return res.status(403).json({ error: "Acceso denegado. Solo médicos pueden acceder." });
    }

    const userId = userRows[0].ID_Usuario;

    // 2. Obtener el ID_Medico
    const [medicoRows] = await connection.query(
      "SELECT ID_Medico FROM medico WHERE ID_Usuario_Auth = ?",
      [userId]
    );

    if (medicoRows.length === 0) {
      return res.status(404).json({ error: "Perfil de médico no encontrado" });
    }

    const idMedico = medicoRows[0].ID_Medico;

    // 3. Obtener todas las citas del médico
    const [citas] = await connection.query(
      `SELECT 
        c.ID_Cita,
        c.Fecha,
        c.Hora,
        c.Estado,
        c.Notas,
        s.Nombre AS Servicio,
        p.Nombre AS Paciente_Nombre,
        p.Telefono AS Paciente_Telefono,
        p.Correo AS Paciente_Correo
      FROM cita c
      INNER JOIN servicio s ON c.ID_Servicio = s.ID_Servicio
      INNER JOIN paciente p ON c.ID_Paciente = p.ID_Paciente
      WHERE c.ID_Medico = ?
        AND c.Estado != 'Cancelada'
        AND c.Fecha >= CURDATE()
      ORDER BY c.Fecha, c.Hora`,
      [idMedico]
    );

    res.json(citas);

  } catch (error) {
    console.error("Error en /api/citas/mis-citas-medico:", error);
    res.status(500).json({ error: "Error al obtener las citas del médico" });
  } finally {
    connection.release();
  }
});
// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});