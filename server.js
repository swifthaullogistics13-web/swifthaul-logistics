
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing. Add it in Render Environment.");
}

if (!ADMIN_KEY) {
  throw new Error("ADMIN_KEY is missing. Add it in Render Environment.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipments (
      id BIGSERIAL PRIMARY KEY,
      tracking_number TEXT UNIQUE NOT NULL,
      sender_name TEXT NOT NULL,
      recipient_name TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      service TEXT NOT NULL,
      package_description TEXT DEFAULT '',
      weight TEXT DEFAULT '',
      eta TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Shipment Created',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      shipment_id BIGINT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      location TEXT DEFAULT '',
      note TEXT DEFAULT '',
      event_time TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS events_shipment_id_idx
    ON events(shipment_id);
  `);

  console.log("SwiftHaul PostgreSQL database is ready.");
}

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function getShipment(trackingNumber) {
  const result = await pool.query(
    "SELECT * FROM shipments WHERE tracking_number = $1",
    [trackingNumber.trim().toUpperCase()]
  );

  if (!result.rows.length) return null;

  const shipment = result.rows[0];

  const events = await pool.query(
    `SELECT status, location, note, event_time
     FROM events
     WHERE shipment_id = $1
     ORDER BY event_time DESC`,
    [shipment.id]
  );

  return { ...shipment, events: events.rows };
}

function makeTracking() {
  return "SHL-" + new Date().getFullYear() + "-" +
    Math.random().toString(36).slice(2, 8).toUpperCase();
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Health check failed:", error);
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.get("/api/track/:tracking", async (req, res) => {
  try {
    const shipment = await getShipment(req.params.tracking);

    if (!shipment) {
      return res.status(404).json({ error: "Tracking number not found" });
    }

    res.json(shipment);
  } catch (error) {
    console.error("Tracking error:", error);
    res.status(500).json({ error: "Unable to retrieve shipment" });
  }
});

app.get("/api/admin/shipments", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM shipments ORDER BY id DESC"
    );

    const shipments = await Promise.all(
      result.rows.map(row => getShipment(row.tracking_number))
    );

    res.json(shipments);
  } catch (error) {
    console.error("Admin shipment list error:", error);
    res.status(500).json({ error: "Unable to retrieve shipments" });
  }
});

app.post("/api/admin/shipments", requireAdmin, async (req, res) => {
  const b = req.body;

  for (const field of [
    "sender_name",
    "recipient_name",
    "origin",
    "destination",
    "service"
  ]) {
    if (!b[field]) {
      return res.status(400).json({ error: `Missing ${field}` });
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let tracking;
    let inserted;

    for (let attempt = 0; attempt < 5; attempt++) {
      tracking = makeTracking();

      try {
        inserted = await client.query(
          `INSERT INTO shipments
           (tracking_number, sender_name, recipient_name, origin,
            destination, service, package_description, weight, eta, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [
            tracking,
            b.sender_name,
            b.recipient_name,
            b.origin,
            b.destination,
            b.service,
            b.package_description || "",
            b.weight || "",
            b.eta || "",
            "Shipment Created"
          ]
        );
        break;
      } catch (error) {
        if (error.code !== "23505" || attempt === 4) throw error;
      }
    }

    const shipment = inserted.rows[0];

    await client.query(
      `INSERT INTO events (shipment_id, status, location, note)
       VALUES ($1, $2, $3, $4)`,
      [
        shipment.id,
        "Shipment Created",
        b.origin,
        "Shipment record created"
      ]
    );

    await client.query("COMMIT");

    res.status(201).json(await getShipment(tracking));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create shipment error:", error);
    res.status(500).json({ error: "Unable to create shipment" });
  } finally {
    client.release();
  }
});

app.post(
  "/api/admin/shipments/:tracking/events",
  requireAdmin,
  async (req, res) => {
    const { status, location = "", note = "" } = req.body;

    if (!status) {
      return res.status(400).json({ error: "Status is required" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        "SELECT * FROM shipments WHERE tracking_number = $1 FOR UPDATE",
        [req.params.tracking.trim().toUpperCase()]
      );

      if (!result.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Shipment not found" });
      }

      const shipment = result.rows[0];

      await client.query(
        `INSERT INTO events (shipment_id, status, location, note)
         VALUES ($1, $2, $3, $4)`,
        [shipment.id, status, location, note]
      );

      await client.query(
        `UPDATE shipments
         SET status = $1, updated_at = NOW()
         WHERE id = $2`,
        [status, shipment.id]
      );

      await client.query("COMMIT");

      res.json(await getShipment(shipment.tracking_number));
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Update shipment error:", error);
      res.status(500).json({ error: "Unable to update shipment" });
    } finally {
      client.release();
    }
  }
);

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`SwiftHaul running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Database startup failed:", error);
    process.exit(1);
  });

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});

