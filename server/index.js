
require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const Stripe = require("stripe");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || "development-secret-change-me";
const DB_FILE = process.env.DB_FILE || (process.env.RENDER ? "/var/data/keljayden.db" : "./data/keljayden.db");
const STRIPE_CURRENCY = process.env.STRIPE_CURRENCY || "eur";
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS admins(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  image_url TEXT NOT NULL DEFAULT '/hero.png',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  zip TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  stock_reserved INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER,
  name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE TABLE IF NOT EXISTS stripe_events(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL
);
`);

// Migration V22 : permet de fermer/archiver une commande terminée ou annulée.
try { db.exec("ALTER TABLE orders ADD COLUMN closed INTEGER NOT NULL DEFAULT 0"); } catch(e) { if(!String(e.message).includes("duplicate column name")) throw e; }

const now = () => new Date().toISOString();
const slugify = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");

if (!db.prepare("SELECT id FROM admins LIMIT 1").get()) {
  const email = process.env.ADMIN_EMAIL || "admin@keljayden-creations.fr";
  const password = process.env.ADMIN_PASSWORD || "ChangeMoi123!";
  db.prepare("INSERT INTO admins(email,password_hash,created_at) VALUES(?,?,?)")
    .run(email, bcrypt.hashSync(password, 12), now());
}

if (!db.prepare("SELECT id FROM products LIMIT 1").get()) {
  const insert = db.prepare(`
    INSERT INTO products(name,slug,description,price_cents,stock,active,image_url,created_at,updated_at)
    VALUES(?,?,?,?,?,1,'/hero.png',?,?)
  `);
  const t = now();
  [
    ["Bracelet Élégance","bracelet-elegance","Bracelet délicat fait main.",2500,12],
    ["Bougie Parfumée","bougie-parfumee","Bougie artisanale parfumée.",1800,8],
    ["Porte-clés Personnalisé","porte-cles-personnalise","Porte-clés personnalisable.",1500,5],
    ["Chouchou Satin","chouchou-satin","Chouchou en satin doux.",800,20]
  ].forEach(p => insert.run(...p,t,t));
}

function auth(req,res,next){
  try{
    const token=req.cookies?.kj_admin;
    if(!token) return res.status(401).json({error:"Non authentifié"});
    const payload=jwt.verify(token,JWT_SECRET);
    const admin=db.prepare("SELECT id,email FROM admins WHERE id=?").get(payload.sub);
    if(!admin) return res.status(401).json({error:"Compte administrateur introuvable"});
    req.admin={sub:admin.id,email:admin.email};
    next();
  }catch{
    res.status(401).json({error:"Session expirée ou invalide"});
  }
}

function userAuth(req,res,next){
  try{
    const token = req.cookies.kj_user;
    if(!token) return res.status(401).json({error:"Non authentifié"});
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  }catch{
    res.status(401).json({error:"Session expirée ou invalide"});
  }
}

function restoreStock(orderId){
  const order = db.prepare("SELECT stock_reserved FROM orders WHERE id=?").get(orderId);
  if(!order || !order.stock_reserved) return;
  const items = db.prepare("SELECT product_id,quantity FROM order_items WHERE order_id=?").all(orderId);
  const up = db.prepare("UPDATE products SET stock=stock+?,updated_at=? WHERE id=?");
  for(const item of items) if(item.product_id) up.run(item.quantity, now(), item.product_id);
  db.prepare("UPDATE orders SET stock_reserved=0,updated_at=? WHERE id=?").run(now(), orderId);
}

/* Stripe webhook MUST be before express.json */

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "KelJayden Créations <onboarding@resend.dev>";

async function sendAccountEmail({to,subject,title,message}){
  if(!RESEND_API_KEY){
    console.log("[Email] RESEND_API_KEY absente : aucun e-mail envoyé à",to);
    return;
  }
  const response=await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{"Authorization":`Bearer ${RESEND_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({
      from:EMAIL_FROM,to:[to],subject,
      html:`<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f7f2ef;padding:30px">
      <div style="max-width:560px;margin:auto;background:#fff;padding:30px;border-radius:10px">
      <h1>KelJayden Créations</h1><h2>${title}</h2><p style="line-height:1.6">${message}</p>
      <p style="font-size:12px;color:#777;margin-top:30px">Si vous n’êtes pas à l’origine de cette connexion, modifiez votre mot de passe.</p>
      </div></body></html>`
    })
  });
  if(!response.ok) console.error("[Email] Erreur Resend:",response.status,await response.text());
}


function promotionIsActive(p){
  if(!p || !p.active) return false;
  const t=Date.now();
  if(p.starts_at && new Date(p.starts_at).getTime()>t) return false;
  if(p.ends_at && new Date(p.ends_at).getTime()<t) return false;
  return true;
}
function discountedPrice(priceCents,promo){
  if(!promotionIsActive(promo)) return priceCents;
  let discount=promo.discount_type==="percent"
    ? Math.round(priceCents*(promo.discount_value/100))
    : promo.discount_value;
  return Math.max(0,priceCents-discount);
}
function getProductPromotion(productId){
  return db.prepare("SELECT * FROM product_promotions WHERE product_id=?").get(productId);
}
function validatePromoCode(code,subtotal){
  if(!code) return {discount:0,promo:null};
  const promo=db.prepare("SELECT * FROM promo_codes WHERE upper(code)=upper(?)").get(String(code).trim());
  if(!promotionIsActive(promo)) return {discount:0,promo:null,error:"Code promo invalide ou expiré"};
  if(subtotal < promo.min_order_cents) return {discount:0,promo:null,error:"Montant minimum non atteint pour ce code"};
  let discount=promo.discount_type==="percent"
    ? Math.round(subtotal*(promo.discount_value/100))
    : promo.discount_value;
  return {discount:Math.min(subtotal,Math.max(0,discount)),promo};
}
app.post("/api/stripe/webhook", express.raw({type:"application/json"}), (req,res)=>{
  if(!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send("Stripe non configuré");
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch(err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if(db.prepare("SELECT id FROM stripe_events WHERE id=?").get(event.id)) {
    return res.json({received:true, duplicate:true});
  }

  try{
    db.transaction(()=>{
      db.prepare("INSERT INTO stripe_events(id,type,received_at) VALUES(?,?,?)")
        .run(event.id,event.type,now());

      const obj = event.data.object;
      const orderId = Number(obj.metadata?.order_id || 0);

      if(orderId && ["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event.type)){
        db.prepare(`
          UPDATE orders
          SET payment_status='paid',
              status=CASE WHEN status='pending' THEN 'preparing' ELSE status END,
              stripe_session_id=?,
              stripe_payment_intent_id=?,
              updated_at=?
          WHERE id=?
        `).run(obj.id, obj.payment_intent || null, now(), orderId);
      }

      if(orderId && event.type==="checkout.session.async_payment_failed"){
        db.prepare("UPDATE orders SET payment_status='failed',updated_at=? WHERE id=?").run(now(),orderId);
        restoreStock(orderId);
      }

      if(orderId && event.type==="checkout.session.expired"){
        db.prepare("UPDATE orders SET payment_status='expired',updated_at=? WHERE id=?").run(now(),orderId);
        restoreStock(orderId);
      }
    })();
    res.json({received:true});
  }catch(err){
    console.error(err);
    res.status(500).json({error:"Erreur traitement webhook"});
  }
});

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"100kb"}));
app.use(cookieParser());
app.use(rateLimit({windowMs:15*60*1000,max:400,standardHeaders:true,legacyHeaders:false}));

/* Public */
app.get("/api/products",(req,res)=>{
  res.json(db.prepare(`
    SELECT id,name,slug,description,price_cents,stock,image_url
    FROM products WHERE active=1 ORDER BY id DESC
  `).all());
});

app.post("/api/checkout/session", async (req,res)=>{
  const {email,first_name,last_name,phone="",address,zip,city,country="France",items,promo_code=""} = req.body || {};
  if(!email || !first_name || !last_name || !address || !zip || !city || !Array.isArray(items) || !items.length){
    return res.status(400).json({error:"Informations de commande incomplètes"});
  }

  const getProduct = db.prepare("SELECT * FROM products WHERE id=? AND active=1");
  const checked = [];
  let subtotal = 0;

  for(const item of items){
    const p = getProduct.get(item.product_id);
    const qty = Number(item.quantity);
    if(!p || !Number.isInteger(qty) || qty < 1) return res.status(400).json({error:"Produit invalide"});
    if(qty > p.stock) return res.status(409).json({error:`Stock insuffisant pour ${p.name}`});
    const unitPrice=discountedPrice(p.price_cents,getProductPromotion(p.id));
    checked.push({p,qty,unitPrice});
    subtotal += unitPrice * qty;
  }
  const promoResult=validatePromoCode(promo_code,subtotal);
  if(promoResult.error) return res.status(400).json({error:promoResult.error});
  const promoDiscount=promoResult.discount||0;
  const discountedSubtotal=Math.max(0,subtotal-promoDiscount);
  const shipping=discountedSubtotal>=7000?0:(discountedSubtotal===0?0:490);
  const total=discountedSubtotal+shipping;
  const number = "KJ-" + Date.now().toString().slice(-8);
  let orderId;

  try{
    db.transaction(()=>{
      const info = db.prepare(`
        INSERT INTO orders(
          number,email,first_name,last_name,phone,address,zip,city,country,
          subtotal_cents,shipping_cents,total_cents,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(number,email,first_name,last_name,phone,address,zip,city,country,subtotal,shipping,total,now(),now());

      orderId = Number(info.lastInsertRowid);
      const addItem = db.prepare("INSERT INTO order_items(order_id,product_id,name,unit_price_cents,quantity) VALUES(?,?,?,?,?)");
      const reserve = db.prepare("UPDATE products SET stock=stock-?,updated_at=? WHERE id=? AND stock>=?");

      for(const {p,qty,unitPrice} of checked){
        addItem.run(orderId,p.id,p.name,unitPrice,qty);
        const r = reserve.run(qty,now(),p.id,qty);
        if(r.changes !== 1) throw new Error(`Le stock de ${p.name} vient de changer. Réessayez.`);
      }
    })();
  }catch(err){
    return res.status(409).json({error:err.message});
  }

  if(!stripe){
    return res.status(201).json({
      demo:true,
      number,
      order_id:orderId,
      total_cents:total,
      message:"Commande enregistrée en mode démonstration. Configurez Stripe dans .env pour encaisser."
    });
  }

  try{
    const line_items = checked.map(({p,qty,unitPrice})=>({
      price_data:{
        currency:STRIPE_CURRENCY,
        product_data:{name:p.name,description:p.description || undefined},
        unit_amount:unitPrice
      },
      quantity:qty
    }));
    let stripeDiscounts;
    if(promoDiscount){
      const coupon=await stripe.coupons.create({amount_off:promoDiscount,currency:STRIPE_CURRENCY,duration:"once",name:`Code promo ${promoResult.promo.code}`});
      stripeDiscounts=[{coupon:coupon.id}];
    }
    if(shipping){
      line_items.push({
        price_data:{currency:STRIPE_CURRENCY,product_data:{name:"Livraison standard"},unit_amount:shipping},
        quantity:1
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode:"payment",
      line_items,
      ...(stripeDiscounts?{discounts:stripeDiscounts}:{}),
      customer_email:email,
      metadata:{order_id:String(orderId),order_number:number},
      success_url:`${APP_URL}/?payment=success&order=${encodeURIComponent(number)}`,
      cancel_url:`${APP_URL}/?payment=cancelled&order=${encodeURIComponent(number)}`,
      locale:"fr",
      expires_at: Math.floor(Date.now()/1000) + 30*60
    });

    db.prepare("UPDATE orders SET stripe_session_id=?,updated_at=? WHERE id=?")
      .run(session.id,now(),orderId);

    res.status(201).json({checkout_url:session.url,number,order_id:orderId,total_cents:total});
  }catch(err){
    console.error(err);
    db.transaction(()=>{
      restoreStock(orderId);
      db.prepare("DELETE FROM order_items WHERE order_id=?").run(orderId);
      db.prepare("DELETE FROM orders WHERE id=?").run(orderId);
    })();
    res.status(502).json({error:"Impossible de créer le paiement Stripe."});
  }
});

app.get("/api/orders/:number",(req,res)=>{
  const order = db.prepare("SELECT number,status,payment_status,total_cents,created_at FROM orders WHERE number=?").get(req.params.number);
  if(!order) return res.status(404).json({error:"Commande introuvable"});
  res.json(order);
});




/* Promotions */
app.post("/api/promotions/validate",(req,res)=>{
  const items=Array.isArray(req.body?.items)?req.body.items:[];
  let subtotal=0;
  for(const item of items){
    const p=db.prepare("SELECT id,price_cents,active FROM products WHERE id=?").get(item.id);
    if(!p || !p.active) continue;
    const qty=Math.max(1,Math.min(99,Number(item.qty)||1));
    subtotal+=discountedPrice(p.price_cents,getProductPromotion(p.id))*qty;
  }
  const result=validatePromoCode(req.body?.code,subtotal);
  if(result.error) return res.status(400).json({error:result.error});
  res.json({ok:true,subtotal_cents:subtotal,discount_cents:result.discount,total_cents:subtotal-result.discount});
});

app.get("/api/admin/promotions",auth,(req,res)=>{
  res.json({
    codes:db.prepare("SELECT * FROM promo_codes ORDER BY id DESC").all(),
    products:db.prepare(`SELECT pp.*,p.name,p.price_cents FROM product_promotions pp JOIN products p ON p.id=pp.product_id ORDER BY p.name`).all()
  });
});
app.post("/api/admin/promo-codes",auth,(req,res)=>{
  let {code,discount_type,discount_value,min_order_cents=0,starts_at=null,ends_at=null}=req.body||{};
  code=String(code||"").trim().toUpperCase();
  discount_value=Number(discount_value);
  if(!/^[A-Z0-9_-]{3,30}$/.test(code)) return res.status(400).json({error:"Code promo invalide"});
  if(!["percent","fixed"].includes(discount_type)) return res.status(400).json({error:"Type de réduction invalide"});
  if(!Number.isFinite(discount_value)||discount_value<=0) return res.status(400).json({error:"Valeur invalide"});
  if(discount_type==="percent" && discount_value>100) return res.status(400).json({error:"Le pourcentage ne peut pas dépasser 100 %"});
  try{
    db.prepare("INSERT INTO promo_codes(code,discount_type,discount_value,min_order_cents,starts_at,ends_at,active,created_at) VALUES(?,?,?,?,?,?,1,?)")
      .run(code,discount_type,Math.round(discount_value),Math.max(0,Number(min_order_cents)||0),starts_at||null,ends_at||null,now());
    res.status(201).json({ok:true});
  }catch(e){res.status(409).json({error:"Ce code promo existe déjà"});}
});
app.patch("/api/admin/promo-codes/:id/toggle",auth,(req,res)=>{
  db.prepare("UPDATE promo_codes SET active=CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=?").run(req.params.id);
  res.json({ok:true});
});
app.delete("/api/admin/promo-codes/:id",auth,(req,res)=>{
  db.prepare("DELETE FROM promo_codes WHERE id=?").run(req.params.id); res.json({ok:true});
});
app.put("/api/admin/product-promotions/:productId",auth,(req,res)=>{
  const {discount_type,discount_value,starts_at=null,ends_at=null}=req.body||{};
  const value=Number(discount_value);
  if(!["percent","fixed"].includes(discount_type)||!Number.isFinite(value)||value<=0) return res.status(400).json({error:"Réduction invalide"});
  if(discount_type==="percent"&&value>100) return res.status(400).json({error:"Maximum 100 %"});
  db.prepare(`INSERT INTO product_promotions(product_id,discount_type,discount_value,starts_at,ends_at,active)
    VALUES(?,?,?,?,?,1) ON CONFLICT(product_id) DO UPDATE SET discount_type=excluded.discount_type,discount_value=excluded.discount_value,starts_at=excluded.starts_at,ends_at=excluded.ends_at,active=1`)
    .run(req.params.productId,discount_type,Math.round(value),starts_at||null,ends_at||null);
  res.json({ok:true});
});
app.delete("/api/admin/product-promotions/:productId",auth,(req,res)=>{
  db.prepare("DELETE FROM product_promotions WHERE product_id=?").run(req.params.productId); res.json({ok:true});
});

/* Admin management */
const PRIMARY_ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@keljayden-creations.fr").trim().toLowerCase();

app.get("/api/admin/admins",auth,(req,res)=>{
  const admins=db.prepare("SELECT id,email,created_at FROM admins ORDER BY id ASC").all();
  res.json(admins.map(a=>({...a,primary:a.email.toLowerCase()===PRIMARY_ADMIN_EMAIL})));
});

app.post("/api/admin/admins",auth,(req,res)=>{
  const email=String(req.body?.email||"").trim().toLowerCase();
  const password=String(req.body?.password||"");

  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    return res.status(400).json({error:"Adresse e-mail invalide"});
  }
  if(password.length<10){
    return res.status(400).json({error:"Le mot de passe doit contenir au moins 10 caractères"});
  }
  if(password.length>128){
    return res.status(400).json({error:"Le mot de passe est trop long"});
  }
  if(db.prepare("SELECT id FROM admins WHERE lower(email)=lower(?)").get(email) ||
     db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(email)){
    return res.status(409).json({error:"Cette adresse e-mail est déjà utilisée"});
  }

  const info=db.prepare("INSERT INTO admins(email,password_hash,created_at) VALUES(?,?,?)")
    .run(email,bcrypt.hashSync(password,12),now());

  res.status(201).json({ok:true,admin:{id:info.lastInsertRowid,email,primary:false}});
});

app.delete("/api/admin/admins/:id",auth,(req,res)=>{
  const target=db.prepare("SELECT id,email FROM admins WHERE id=?").get(req.params.id);
  if(!target) return res.status(404).json({error:"Administrateur introuvable"});

  if(target.email.toLowerCase()===PRIMARY_ADMIN_EMAIL){
    return res.status(403).json({error:"L’administrateur principal ne peut pas être supprimé"});
  }
  if(Number(target.id)===Number(req.admin.sub)){
    return res.status(400).json({error:"Vous ne pouvez pas supprimer votre propre compte pendant cette session"});
  }

  db.prepare("DELETE FROM admins WHERE id=?").run(target.id);
  res.json({ok:true});
});

/* Customer accounts */
app.post("/api/account/register",async (req,res)=>{
  let {first_name,last_name="",email,password}=req.body||{};
  first_name=String(first_name||"").trim();
  last_name=String(last_name||"").trim();
  email=String(email||"").trim().toLowerCase();
  password=String(password||"");

  if(!first_name || !email || !password){
    return res.status(400).json({error:"Prénom, e-mail et mot de passe obligatoires"});
  }
  if(first_name.length>80 || last_name.length>80 || email.length>180){
    return res.status(400).json({error:"Informations trop longues"});
  }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    return res.status(400).json({error:"Adresse e-mail invalide"});
  }
  if(password.length<10){
    return res.status(400).json({error:"Le mot de passe doit contenir au moins 10 caractères"});
  }
  if(password.length>128){
    return res.status(400).json({error:"Le mot de passe est trop long"});
  }
  if(db.prepare("SELECT id FROM admins WHERE lower(email)=lower(?)").get(email)){
    return res.status(409).json({error:"Cette adresse e-mail est déjà utilisée"});
  }
  if(db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(email)){
    return res.status(409).json({error:"Un compte existe déjà avec cette adresse e-mail"});
  }

  const info=db.prepare(
    "INSERT INTO users(first_name,last_name,email,password_hash,created_at) VALUES(?,?,?,?,?)"
  ).run(first_name,last_name,email,bcrypt.hashSync(password,12),now());

  const token=jwt.sign(
    {sub:info.lastInsertRowid,email,role:"customer"},
    JWT_SECRET,
    {expiresIn:"30d"}
  );
  res.cookie("kj_user",token,{
    httpOnly:true,
    sameSite:"lax",
    secure:process.env.NODE_ENV==="production",
    maxAge:30*24*60*60*1000
  });
  try{
    await sendAccountEmail({
      to:email,
      subject:"Bienvenue chez KelJayden Créations",
      title:"Votre compte est créé",
      message:`Bonjour ${first_name}, votre compte KelJayden Créations a bien été créé.`
    });
  }catch(err){console.error("[Email inscription]",err)}
  res.status(201).json({
    ok:true,
    role:"customer",
    user:{id:info.lastInsertRowid,first_name,last_name,email}
  });
});

app.post("/api/account/login",async (req,res)=>{
  const email=String(req.body?.email||"").trim().toLowerCase();
  const password=String(req.body?.password||"");

  const admin=db.prepare("SELECT * FROM admins WHERE lower(email)=lower(?)").get(email);
  if(admin && bcrypt.compareSync(password,admin.password_hash)){
    const token=jwt.sign({sub:admin.id,email:admin.email,role:"admin"},JWT_SECRET,{expiresIn:"8h"});
    res.cookie("kj_admin",token,{
      httpOnly:true,
      sameSite:"lax",
      secure:process.env.NODE_ENV==="production",
      maxAge:8*60*60*1000
    });
    res.clearCookie("kj_user");
    try{await sendAccountEmail({
      to:admin.email,subject:"Nouvelle connexion — KelJayden Créations",
      title:"Connexion administrateur",
      message:"Une connexion à votre compte administrateur vient d’être effectuée."
    })}catch(err){console.error("[Email connexion admin]",err)}
    return res.json({ok:true,role:"admin",email:admin.email});
  }

  const user=db.prepare("SELECT * FROM users WHERE lower(email)=lower(?)").get(email);
  if(!user || !bcrypt.compareSync(password,user.password_hash)){
    return res.status(401).json({error:"E-mail ou mot de passe incorrect"});
  }

  const token=jwt.sign({sub:user.id,email:user.email,role:"customer"},JWT_SECRET,{expiresIn:"30d"});
  res.cookie("kj_user",token,{
    httpOnly:true,
    sameSite:"lax",
    secure:process.env.NODE_ENV==="production",
    maxAge:30*24*60*60*1000
  });
  res.clearCookie("kj_admin");
  try{await sendAccountEmail({
    to:user.email,subject:"Nouvelle connexion — KelJayden Créations",
    title:"Connexion à votre compte",
    message:`Bonjour ${user.first_name}, une connexion à votre compte KelJayden Créations vient d’être effectuée.`
  })}catch(err){console.error("[Email connexion client]",err)}
  res.json({
    ok:true,
    role:"customer",
    user:{id:user.id,first_name:user.first_name,last_name:user.last_name,email:user.email}
  });
});

app.get("/api/account/me",(req,res)=>{
  try{
    if(req.cookies.kj_admin){
      const adminToken=jwt.verify(req.cookies.kj_admin,JWT_SECRET);
      const admin=db.prepare("SELECT id,email FROM admins WHERE id=?").get(adminToken.sub);
      if(admin) return res.json({logged:true,role:"admin",user:admin});
    }
  }catch{}
  try{
    if(req.cookies.kj_user){
      const userToken=jwt.verify(req.cookies.kj_user,JWT_SECRET);
      const user=db.prepare("SELECT id,first_name,last_name,email,created_at FROM users WHERE id=?").get(userToken.sub);
      if(user) return res.json({logged:true,role:"customer",user});
    }
  }catch{}
  res.status(401).json({logged:false,error:"Non authentifié"});
});

app.get("/api/account/orders",(req,res)=>{
  try{
    const token=req.cookies.kj_user;
    if(!token) return res.status(401).json({error:"Non authentifié"});
    const payload=jwt.verify(token,JWT_SECRET);
    const user=db.prepare("SELECT id,email FROM users WHERE id=?").get(payload.sub);
    if(!user) return res.status(401).json({error:"Compte introuvable"});
    const orders=db.prepare(`
      SELECT number,status,payment_status,total_cents,created_at,updated_at
      FROM orders
      WHERE lower(email)=lower(?)
      ORDER BY id DESC
    `).all(user.email);
    res.json(orders);
  }catch(e){
    res.status(401).json({error:"Session invalide"});
  }
});

app.post("/api/account/logout",(req,res)=>{
  res.clearCookie("kj_user");
  res.clearCookie("kj_admin");
  res.json({ok:true});
});


/* Admin auth */
app.post("/api/admin/login",(req,res)=>{
  const {email,password} = req.body || {};
  const admin = db.prepare("SELECT * FROM admins WHERE email=?").get(email);
  if(!admin || !bcrypt.compareSync(password || "", admin.password_hash)){
    return res.status(401).json({error:"E-mail ou mot de passe incorrect"});
  }
  const token = jwt.sign({sub:admin.id,email:admin.email},JWT_SECRET,{expiresIn:"8h"});
  res.cookie("kj_admin",token,{
    httpOnly:true,
    sameSite:"lax",
    secure:process.env.NODE_ENV==="production",
    maxAge:8*60*60*1000
  });
  res.json({ok:true,email:admin.email});
});

app.post("/api/admin/logout",(req,res)=>{
  res.clearCookie("kj_admin");
  res.json({ok:true});
});
app.get("/api/admin/me",auth,(req,res)=>res.json({id:req.admin.sub,email:req.admin.email}));

app.post("/api/admin/change-email", auth, (req,res)=>{
  const email=String(req.body?.email||"").trim().toLowerCase();
  const current_password=String(req.body?.current_password||"");
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:"Adresse e-mail invalide"});
  const admin=db.prepare("SELECT * FROM admins WHERE id=?").get(req.admin.sub);
  if(!admin || !bcrypt.compareSync(current_password,admin.password_hash)) return res.status(401).json({error:"Mot de passe actuel incorrect"});
  if(admin.email.toLowerCase()===email) return res.status(400).json({error:"C’est déjà votre adresse e-mail"});
  if(db.prepare("SELECT id FROM admins WHERE lower(email)=lower(?) AND id<>?").get(email,admin.id) || db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(email)) return res.status(409).json({error:"Cette adresse e-mail est déjà utilisée"});
  db.prepare("UPDATE admins SET email=? WHERE id=?").run(email,admin.id);

  // Recrée immédiatement la session avec la nouvelle adresse.
  // Le Dashboard reste donc accessible après la modification.
  const token=jwt.sign({sub:admin.id,email},JWT_SECRET,{expiresIn:"8h"});
  res.cookie("kj_admin",token,{
    httpOnly:true,
    sameSite:"lax",
    secure:process.env.NODE_ENV==="production",
    maxAge:8*60*60*1000
  });
  res.json({ok:true,email,message:"Adresse e-mail modifiée avec succès."});
});

app.post("/api/admin/change-password", auth, (req,res)=>{
  const {current_password,new_password} = req.body || {};
  if(typeof current_password!=="string" || typeof new_password!=="string"){
    return res.status(400).json({error:"Informations manquantes"});
  }
  if(new_password.length < 10){
    return res.status(400).json({error:"Le nouveau mot de passe doit contenir au moins 10 caractères"});
  }
  if(new_password.length > 128){
    return res.status(400).json({error:"Le nouveau mot de passe est trop long"});
  }
  if(current_password === new_password){
    return res.status(400).json({error:"Le nouveau mot de passe doit être différent de l'ancien"});
  }
  const admin = db.prepare("SELECT * FROM admins WHERE id=?").get(req.admin.sub);
  if(!admin || !bcrypt.compareSync(current_password,admin.password_hash)){
    return res.status(401).json({error:"Mot de passe actuel incorrect"});
  }
  const hash=bcrypt.hashSync(new_password,12);
  db.prepare("UPDATE admins SET password_hash=? WHERE id=?").run(hash,admin.id);
  res.clearCookie("kj_admin");
  res.json({ok:true,message:"Mot de passe modifié. Reconnectez-vous avec le nouveau mot de passe."});
});


/* Admin products */
app.get("/api/admin/products",auth,(req,res)=>{
  res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all());
});

app.post("/api/admin/products",auth,(req,res)=>{
  const {name,description="",price_cents,stock=0,active=true,image_url="/hero.png"} = req.body || {};
  if(!name || !Number.isInteger(price_cents) || price_cents<0 || !Number.isInteger(stock) || stock<0){
    return res.status(400).json({error:"Données produit invalides"});
  }
  const t=now(), slug=slugify(name)+"-"+Date.now();
  const info=db.prepare(`
    INSERT INTO products(name,slug,description,price_cents,stock,active,image_url,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(name,slug,description,price_cents,stock,active?1:0,image_url||"/hero.png",t,t);
  res.status(201).json(db.prepare("SELECT * FROM products WHERE id=?").get(info.lastInsertRowid));
});

app.put("/api/admin/products/:id",auth,(req,res)=>{
  const old=db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if(!old) return res.status(404).json({error:"Produit introuvable"});
  const {name,description="",price_cents,stock,active=true,image_url="/hero.png"}=req.body||{};
  if(!name || !Number.isInteger(price_cents) || price_cents<0 || !Number.isInteger(stock) || stock<0){
    return res.status(400).json({error:"Données invalides"});
  }
  db.prepare(`
    UPDATE products SET name=?,description=?,price_cents=?,stock=?,active=?,image_url=?,updated_at=? WHERE id=?
  `).run(name,description,price_cents,stock,active?1:0,image_url||"/hero.png",now(),old.id);
  res.json(db.prepare("SELECT * FROM products WHERE id=?").get(old.id));
});

app.delete("/api/admin/products/:id",auth,(req,res)=>{
  const product = db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if(!product) return res.status(404).json({error:"Annonce introuvable"});

  const used = db.prepare("SELECT COUNT(*) AS count FROM order_items WHERE product_id=?").get(product.id).count;

  if(used > 0){
    db.prepare("UPDATE products SET active=0,updated_at=? WHERE id=?").run(now(),product.id);
    return res.json({
      ok:true,
      archived:true,
      message:"Annonce retirée. Elle est conservée uniquement pour l’historique des commandes."
    });
  }

  db.prepare("DELETE FROM products WHERE id=?").run(product.id);
  res.json({ok:true,deleted:true,message:"Annonce supprimée définitivement."});
});

/* Admin orders */
app.get("/api/admin/orders",auth,(req,res)=>{
  const orders=db.prepare("SELECT * FROM orders ORDER BY id DESC").all();
  const itemStmt=db.prepare("SELECT * FROM order_items WHERE order_id=? ORDER BY id");
  res.json(orders.map(o=>({...o,items:itemStmt.all(o.id)})));
});

app.patch("/api/admin/orders/:id/status",auth,async(req,res)=>{
  const allowed=["pending","preparing","shipped","completed","cancelled"];
  const {status}=req.body||{};
  if(!allowed.includes(status)) return res.status(400).json({error:"Statut invalide"});
  const order=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if(!order) return res.status(404).json({error:"Commande introuvable"});
  if(status==="cancelled" && order.payment_status!=="paid") restoreStock(order.id);

  const previousStatus=order.status;
  db.prepare("UPDATE orders SET status=?,updated_at=? WHERE id=?").run(status,now(),order.id);

  // Envoie l'e-mail uniquement au moment du passage vers "Expédiée".
  if(status==="shipped" && previousStatus!=="shipped"){
    try{
      await sendAccountEmail({
        to:order.email,
        subject:`Votre commande ${order.number} a été expédiée`,
        title:"Votre commande est en route",
        message:`Bonjour ${order.first_name}, votre commande <strong>${order.number}</strong> a été expédiée. Merci pour votre commande chez KelJayden Créations.`
      });
    }catch(err){
      console.error("[Email expédition]",err);
    }
  }
  res.json({ok:true});
});

app.patch("/api/admin/orders/:id/close",auth,(req,res)=>{
  const order=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if(!order) return res.status(404).json({error:"Commande introuvable"});
  if(!["completed","cancelled"].includes(order.status)) return res.status(400).json({error:"La commande doit être terminée ou annulée avant de pouvoir être fermée"});
  db.prepare("UPDATE orders SET closed=1,updated_at=? WHERE id=?").run(now(),order.id);
  res.json({ok:true});
});

app.get("/api/admin/stats",auth,(req,res)=>{
  const revenue=db.prepare("SELECT COALESCE(SUM(total_cents),0) AS v FROM orders WHERE payment_status='paid'").get().v;
  const orders=db.prepare("SELECT COUNT(*) AS v FROM orders").get().v;
  const products=db.prepare("SELECT COUNT(*) AS v FROM products WHERE active=1").get().v;
  const low=db.prepare("SELECT COUNT(*) AS v FROM products WHERE active=1 AND stock<=5").get().v;
  res.json({revenue_cents:revenue,orders,products,low_stock:low});
});

app.get("/admin",(req,res)=>{ res.sendFile(path.join(__dirname,"../public/admin.html")); });

app.use(express.static(path.join(__dirname,"../public")));

app.get("/api/site/about",(req,res)=>{const rows=db.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'about_%'").all();res.json(Object.fromEntries(rows.map(r=>[r.key,r.value])));});
app.put("/api/admin/site/about",auth,(req,res)=>{const b=req.body||{};for(const k of ["about_kicker","about_title","about_text","about_image"]){if(typeof b[k]!=="string") return res.status(400).json({error:"Contenu invalide"});} if(!b.about_title.trim()||!b.about_text.trim()) return res.status(400).json({error:"Le titre et le texte sont obligatoires"}); const up=db.prepare("INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"); const tx=db.transaction(()=>{for(const k of ["about_kicker","about_title","about_text","about_image"]) up.run(k,b[k].trim())});tx();res.json({ok:true});});

app.listen(PORT,"0.0.0.0",()=>console.log(`KelJayden Créations : ${APP_URL}`));db.exec(`CREATE TABLE IF NOT EXISTS promo_codes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
  discount_value INTEGER NOT NULL,
  min_order_cents INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_promotions(
  product_id INTEGER PRIMARY KEY,
  discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
  discount_value INTEGER NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');`);
const aboutDefaults={about_kicker:"L’histoire de KelJayden Créations ♡",about_title:"Des créations pensées avec le cœur",about_text:"Chaque pièce est imaginée avec soin pour vous offrir des créations uniques et authentiques.",about_image:""};
for(const [k,v] of Object.entries(aboutDefaults)) db.prepare("INSERT OR IGNORE INTO site_settings(key,value) VALUES(?,?)").run(k,v);


