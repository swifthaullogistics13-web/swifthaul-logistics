const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-this-admin-key";

const db = new Database("swifthaul.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  location TEXT DEFAULT '',
  note TEXT DEFAULT '',
  event_time TEXT NOT NULL,
  FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
);
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function makeTracking() {
  let n;
  do {
    n = "SHL-" + new Date().getFullYear() + "-" +
      Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (db.prepare("SELECT 1 FROM shipments WHERE tracking_number=?").get(n));
  return n;
}

function shipmentView(s) {
  if (!s) return null;
  const events = db.prepare(
    "SELECT status,location,note,event_time FROM events WHERE shipment_id=? ORDER BY event_time DESC"
  ).all(s.id);
  return {...s, events};
}

app.get("/api/track/:tracking", (req,res)=>{
  const s = db.prepare("SELECT * FROM shipments WHERE tracking_number=?")
    .get(req.params.tracking.trim().toUpperCase());
  if (!s) return res.status(404).json({error:"Tracking number not found"});
  res.json(shipmentView(s));
});

app.get("/api/admin/shipments", (req,res)=>{
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({error:"Unauthorized"});
  res.json(db.prepare("SELECT * FROM shipments ORDER BY id DESC").all().map(shipmentView));
});

app.post("/api/admin/shipments", (req,res)=>{
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({error:"Unauthorized"});
  const b=req.body;
  for (const k of ["sender_name","recipient_name","origin","destination","service"])
    if (!b[k]) return res.status(400).json({error:`Missing ${k}`});
  const now=new Date().toISOString();
  const tracking=makeTracking();
  const info=db.prepare(`
    INSERT INTO shipments
    (tracking_number,sender_name,recipient_name,origin,destination,service,package_description,weight,eta,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    tracking,b.sender_name,b.recipient_name,b.origin,b.destination,b.service,
    b.package_description||"",b.weight||"",b.eta||"","Shipment Created",now,now
  );
  db.prepare(`INSERT INTO events(shipment_id,status,location,note,event_time)
              VALUES(?,?,?,?,?)`)
    .run(info.lastInsertRowid,"Shipment Created",b.origin,"Shipment record created",now);
  res.status(201).json(shipmentView(db.prepare("SELECT * FROM shipments WHERE id=?").get(info.lastInsertRowid)));
});

app.post("/api/admin/shipments/:tracking/events",(req,res)=>{
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({error:"Unauthorized"});
  const s=db.prepare("SELECT * FROM shipments WHERE tracking_number=?")
    .get(req.params.tracking.toUpperCase());
  if(!s) return res.status(404).json({error:"Shipment not found"});
  const {status,location="",note=""}=req.body;
  if(!status) return res.status(400).json({error:"Status is required"});
  const now=new Date().toISOString();
  db.prepare("INSERT INTO events(shipment_id,status,location,note,event_time) VALUES(?,?,?,?,?)")
    .run(s.id,status,location,note,now);
  db.prepare("UPDATE shipments SET status=?,updated_at=? WHERE id=?")
    .run(status,now,s.id);
  res.json(shipmentView(db.prepare("SELECT * FROM shipments WHERE id=?").get(s.id)));
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`SwiftHaul running on http://localhost:${PORT}`));
