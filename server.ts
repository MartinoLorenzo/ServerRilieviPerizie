//A.  Import delle librerie
import fs from "fs";
import express, { CookieOptions } from "express";
import dotenv from "dotenv"
import { Document, MongoClient, ObjectId, WithId } from "mongodb";
import queryStringParser from "./queryStringParser";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import nodemailer from "nodemailer";
import fileManager from "./filemanager";
import fileupload from "express-fileupload";
import { google } from 'googleapis';

// i parametri GET sono restituiti dentro req.query
// i parametri POST sono restituiti dentro req.body
// i parametri passati come risorsa sono restituiti dentro req.params

//B.  Configurazioni
const app: express.Express = express();
dotenv.config({
    path: ".env"
});
const connectionString = process.env.connectionStringAtlas;
const dbName = process.env.dbName;
const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);

oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN!
});

// Creazione ed avvio sel server https
const jwtKey = process.env.JWT_SECRET_KEY || "123456789";
const PORT = process.env.PORT || 3000;

app.listen(PORT, function () {
    console.log("Server in ascolto sulla porta: " + PORT);
});

//D.  Middleware
// 1. Request Log
app.use("/", function (req, res, next) {
    //originalUrl è la url completa richiesta dal client
    console.log(req.method + ": " + req.originalUrl);
    next();
});

// 2. Gestione risorse statiche
app.use("/", express.static("./static"));

// 3. Lettura dei parametri post
app.use("/", express.json({ "limit": "5mb" }));

// 4. Parsing dei parametri GET
app.use("/", queryStringParser);

// 5. Lettura del FormData
app.use(fileupload({
    "limits": { "fileSize": (20 * 1024 * 1024) }
}));

// 6. Log dei parametri 
app.use("/", function (req: any, res, next) {
    if (req["parsedQuery"] && Object.keys(req["parsedQuery"]).length > 0)
        console.log("   Parametri Query: " + JSON.stringify(req["parsedQuery"]));
    if (req["body"] && Object.keys(req["body"]).length > 0)
        console.log("   Parametri Body: " + JSON.stringify(req["body"]));
    next();
});

// 7. Vincoli CORS
const corsOptions = {
    origin: function (origin: any, callback: any) {
        return callback(null, true);
    },
    credentials: true
};
app.use("/", cors(corsOptions));

// 8. Parsing dei cookies
app.use(cookieParser());

// D2. Gestione login e token
const cookiesOptions: CookieOptions = {
    "path": "/",
    "httpOnly": true,
    "secure": true,
    "maxAge": parseInt(process.env.DURATA_TOKEN || "3600") * 1000,
    "sameSite": "none"
};

// 1. Servizio di Login/Logout/Signup
app.post("/api/login", async function (req, res, next) {
    const username = req.body.username;
    const password = req.body.password;
    const client = new MongoClient(connectionString!);

    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection("utenti");

        const dbUser = await collection.findOne({ username });

        if (!dbUser) {
            return res.status(401).json({ message: "Username non valido!" });
        }

        const isPasswordOk = await bcrypt.compare(password, dbUser.password || "");

        if (!isPasswordOk) {
            return res.status(401).json({ message: "Password non valida!" });
        }

        const TOKEN = createToken(dbUser);
        res.cookie("TOKEN", TOKEN, cookiesOptions);

        res.send({
            token: TOKEN,
            username: dbUser.username,
            role: dbUser.role,
            info: dbUser.info || { nome: "", cognome: "" }
        });

    } catch (error: any) {
        console.error("ERRORE LOGIN:", error);

        if (error.name == 'MongoNetworkError') {
            res.status(503).send("Errore di connessione al Database");
        } else {
            res.status(500).send("Errore interno del server: " + error.message);
        }
    } finally {
        await client.close();
    }
});

// 2. LoginWithGoogle
app.post("/api/login-google", async (req, res) => {
    const googleToken = req.body.googleToken;
    const requestedRole = req.body.role || "user";

    const payloadGoogleToken: any = jwt.decode(googleToken);
    console.log("Google token payload: ", payloadGoogleToken);

    const client = new MongoClient(connectionString!);
    const currentCollection = "utenti";

    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);

        let dbUser: any = await collection.findOne({ "username": payloadGoogleToken.email });

        if (!dbUser) {
            console.log(`Utente non trovato, creazione nuovo profilo con ruolo: ${requestedRole}...`);

            let passwordInChiaro: string = "";
            for (let i = 0; i < 10; i++) {
                passwordInChiaro += String.fromCharCode(Math.floor(Math.random() * 26) + 65);
            }

            const newUser: any = {
                "username": payloadGoogleToken.email,
                "password": bcrypt.hashSync(passwordInChiaro, 10),
                "info": {
                    "nome": payloadGoogleToken.given_name || "",
                    "cognome": payloadGoogleToken.family_name || ""
                },
                "role": requestedRole
            };

            const result = await collection.insertOne(newUser);
            newUser._id = result.insertedId;

            await sendGmail(payloadGoogleToken.email, passwordInChiaro);

            dbUser = newUser;
        }

        const token = createToken(dbUser);
        res.cookie("TOKEN", token, cookiesOptions);

        res.send({
            token: token,
            "username": payloadGoogleToken.email,
            "role": dbUser.role,
            "info": dbUser.info
        });

    } catch (error: any) {
        console.error("ERRORE LOGIN GOOGLE:", error);

        if (error.name == 'MongoNetworkError') {
            res.status(503).send("Errore di connessione al Database");
        } else {
            res.status(500).send("Errore interno del server: " + error.message);
        }
    } finally {
        await client.close();
    }
});

// Controllo TOKEN
app.use("/api/", function (req: any, res, next) {
    let TOKEN = null;

    if (req.cookies && req.cookies.TOKEN) {
        TOKEN = req.cookies.TOKEN;
    }
    else if (req.headers['authorization']) {
        const authHeader = req.headers['authorization'];
        TOKEN = authHeader && authHeader.split(' ')[1];
    }

    if (!TOKEN) {
        res.status(403).send("Token mancante");
    } else {
        jwt.verify(TOKEN, jwtKey, function (err: any, payload: any) {
            if (err) {
                console.log("Token non valido o scaduto");
                res.status(403).send("Token non valido o scaduto");
            } else {
                res.cookie("TOKEN", TOKEN, cookiesOptions);

                req["username"] = payload.username;
                next();
            }
        });
    }
});

app.post("/api/logout", async function (req: any, res, next) {
    const options = {
        ...cookiesOptions,
        maxAge: -1
    };
    res.cookie("TOKEN", "", options);
    res.send({ "ok": 1 });
});

//E.  Gestione delle risorse dinamiche

// PERIZIE
app.get("/api/perizie", async function (req: any, res, next) {
    let searchParam = req["parsedQuery"]?.search;
    let userFilter = req["parsedQuery"]?.user;

    if (searchParam == "null" || searchParam == "undefined" || !searchParam) {
        searchParam = null;
    }
    else if (Number.isInteger(Number(searchParam))) {
        searchParam = searchParam.toString();
    }

    if (userFilter == "null" || userFilter == "undefined" || !userFilter || userFilter == "Tutti gli utenti") {
        userFilter = null;
    }

    const client = new MongoClient(connectionString!);
    const currentCollection = "perizie";
    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);

        let andConditions: any[] = [];

        if (userFilter) {
            andConditions.push({ operatore: userFilter });
        }

        if (searchParam) {
            const regexSearch = { $regex: searchParam, $options: "i" };
            andConditions.push({
                $or: [
                    { codice: regexSearch },
                    { descrizione: regexSearch },
                    { operatore: regexSearch },
                    { data_ora: regexSearch }
                ]
            });
        }

        let query = andConditions.length > 0 ? { $and: andConditions } : {};

        const result = await collection.find(query).toArray();
        res.status(200).send(result);
    } catch (err) {
        res.status(500).json({ message: "Errore esecuzione query: " + err });
    }
    finally {
        await client.close();
    }
});

app.get("/api/recent-perizie", async function (req: any, res, next) {
    const client = new MongoClient(connectionString!);
    const currentCollection = "perizie";

    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);

        const result = await collection
            .find({})
            .sort({ data_ora: -1 })
            .limit(5)
            .toArray();

        res.status(200).send(result);
    } catch (err) {
        res.status(500).json({ message: "Errore esecuzione query: " + err });
    } finally {
        await client.close();
    }
});

app.get("/api/count-perizie", async function (req: any, res, next) {
    const query = req["parsedQuery"] || {};

    const username = (query.username == "null" || query.username == "undefined") ? null : query.username;
    const date = (query.date == "null" || query.date == "undefined") ? null : query.date;
    const client = new MongoClient(connectionString!);
    const currentCollection = "perizie";

    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);
        const filters: any = {};

        if (username) {
            filters.operatore = username;
        }

        if (date) {
            const dataRiferimento = new Date(date);

            if (!isNaN(dataRiferimento.getTime())) {
                dataRiferimento.setDate(dataRiferimento.getDate() - 30);

                const dataLimiteString = dataRiferimento.toISOString();
                filters.data_ora = { $gte: dataLimiteString };
            }
        }

        const result = await collection.countDocuments(filters);
        res.status(200).send({ count: result });

    } catch (err) {
        res.status(500).send("Errore esecuzione query: " + err);
    }
    finally {
        await client.close();
    }
});

app.put("/api/perizie/:codice", async function (req: any, res, next) {
    const codicePerizia = req.params.codice
    const param = req.body;
    const client = new MongoClient(connectionString!);
    const currentCollection = "perizie";

    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);

        const query: any = { "codice": codicePerizia };
        let updateQuery = {};

        if (param.url && param.commento !== undefined && !param.descrizione) {
            query["fotografie.url"] = param.url;

            updateQuery = {
                $set: { "fotografie.$.commento": param.commento }
            };
        }
        else {
            updateQuery = { $set: param };
        }

        const result = await collection.updateOne(query, updateQuery);

        if (result.matchedCount == 0) {
            res.status(404).json({ message: "Nessuna perizia trovata con il codice inserito o URL foto errato" });
        } else {
            res.status(200).json({ message: "Aggiornamento completato con successo" });
        }
    } catch (err) {
        res.status(500).json({ message: "Errore esecuzione query: " + err });
    } finally {
        await client.close();
    }
});

app.post("/api/save-perizie", async function (req: any, res, next) {
    const client = new MongoClient(connectionString!);
    const currentCollection = "perizie";

    try {
        if (!req.body.data) {
            return res.status(400).json({ message: "Dati della perizia mancanti." });
        }

        const periziaDati = JSON.parse(req.body.data);

        periziaDati.operatore = req["username"];
        const fotografieFinali: any[] = [];

        if (req.files && req.files.files) {
            const fileList = Array.isArray(req.files.files) ? req.files.files : [req.files.files];

            for (let i = 0; i < fileList.length; i++) {
                const file = fileList[i];

                console.log(`Caricamento su Cloudinary del file: ${file.name}`);

                const cloudinaryResult = await fileManager.saveBinaryCloudinary(file.name, file.data).catch(function (err: any) {
                    console.error(`Errore Cloudinary per il file ${file.name}:`, err);
                    return null;
                });

                if (!cloudinaryResult) {
                    return res.status(500).json({ message: `Errore durante il caricamento dell'immagine ${file.name} su Cloudinary.` });
                }

                const metadatoCorrispondente = periziaDati.fotografie.find((f: any) => f.public_id == file.name);
                const commento = metadatoCorrispondente ? metadatoCorrispondente.commento : "";

                fotografieFinali.push({
                    url: cloudinaryResult.secure_url,
                    public_id: file.name,
                    commento: commento
                });
            }
        }

        periziaDati.fotografie = fotografieFinali;

        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);

        const result = await collection.insertOne(periziaDati);

        console.log("Perizia e immagini salvate con successo. ID:", result.insertedId);

        res.status(200).json({
            message: "Perizia salvata con successo",
            id: result.insertedId,
            codice: periziaDati.codice
        });

    } catch (err: any) {
        console.error("ERRORE SALVATAGGIO PERIZIA:", err);
        res.status(500).json({ message: "Errore interno del server: " + err.message });
    } finally {
        await client.close();
    }
});

app.delete("/api/delete-perizia", async function (req: any, res, next) {
    const perizia = req.body?.perizia;
    const codicePerizia = perizia?.codice;

    if (!codicePerizia) {
        return res.status(400).json({ message: "Dati o codice della perizia mancanti nel body." });
    }

    const client = new MongoClient(connectionString!);
    const currentCollection = "perizie";

    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);

        const query = { "codice": codicePerizia };

        const result = await collection.deleteOne(query);

        if (result.deletedCount == 0) {
            res.status(404).json({ message: "Nessuna perizia trovata con il codice fornito." });
        } else {
            res.status(200).json({ message: "Perizia eliminata con successo." });
        }
    } catch (err: any) {
        console.error("ERRORE ELIMINAZIONE PERIZIA:", err);
        res.status(500).json({ message: "Errore interno del server: " + err.message });
    } finally {
        await client.close();
    }
});

// UTENTI
app.get("/api/utenti", async function (req: any, res, next) {
    let searchParam = req["parsedQuery"]?.search;
    if (searchParam == "null" || searchParam == "undefined" || !searchParam) {
        searchParam = null;
    }
    const client = new MongoClient(connectionString!);
    const currentCollection = "utenti";
    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);

        let query = {};

        if (searchParam) {
            const regexSearch = { $regex: searchParam, $options: "i" };

            query = {
                $or: [
                    { username: regexSearch },
                    { role: regexSearch }
                ]
            };

        }

        const result = await collection
            .find(query)
            .project({ password: 0 })
            .sort({ _id: -1 })
            .toArray();

        res.status(200).send(result);
    } catch (err) {
        res.status(500).json({ message: "Errore esecuzione query: " + err });
    }
    finally {
        await client.close();
    }
});

app.get("/api/recent-utenti", async function (req: any, res, next) {
    const client = new MongoClient(connectionString!);
    const currentCollection = "utenti";

    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);

        const result = await collection
            .find({})
            .project({ password: 0 })
            .sort({ _id: -1 })
            .limit(5)
            .toArray();

        res.status(200).send(result);
    } catch (err) {
        res.status(500).send("Errore esecuzione query: " + err);
    } finally {
        await client.close();
    }
});

app.get("/api/count-utenti", async function (req: any, res, next) {
    const params = req["parsedQuery"] || {};
    const client = new MongoClient(connectionString!);
    const currentCollection = "utenti";

    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);

        const result = await collection.countDocuments(params ? params : {});

        res.status(200).send({ count: result });

    } catch (err) {
        res.status(500).send("Errore esecuzione query: " + err);
    }
    finally {
        await client.close();
    }
});

app.post("/api/add-user", async function (req: any, res, next) {
    const params = req.body;
    const client = new MongoClient(connectionString!);
    const currentCollection = "utenti";

    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);

        const userExists = await collection.findOne({ "username": params.email });
        if (userExists) {
            return res.status(409).json({ message: "Email già utilizzata" });
        }

        let passwordInChiaro: string = "";
        for (let i = 0; i < 10; i++) {
            passwordInChiaro += String.fromCharCode(Math.floor(Math.random() * 26) + 65);
        }
        const hashedPassword = await bcrypt.hash(passwordInChiaro, 10);
        await sendGmail(params.email, passwordInChiaro);

        const newUser = {
            "username": params.email,
            "password": hashedPassword,
            "info": params.infoAggiuntive || {},
            "role": "user"
        };
        const result = await collection.insertOne(newUser);

        res.status(200).json({ message: "Operatore aggiunto con successo" });
    } catch (err) {
        res.status(500).json({ message: "Errore esecuzione query: " + err });
    }
    finally {
        await client.close();
    }
});

app.delete("/api/delete-user", async function (req: any, res, next) {
    const username = req["parsedQuery"]?.username;
    const client = new MongoClient(connectionString!);
    const currentCollection = "utenti";
    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);
        const result = await collection.deleteOne({ "username": username });
        if (result.deletedCount == 0) {
            res.status(404).json({ message: "Utente non trovato" });
        } else {
            res.status(200).json({ message: "Utente eliminato con successo" });
        }
    } catch (err) {
        res.status(500).json({ message: "Errore esecuzione query: " + err });
    } finally {
        await client.close();
    }
});

app.put("/api/update-user", async function (req: any, res, next) {
    const username = req.body.username;
    const infoAggiuntive = req.body.infoAggiuntive;
    const client = new MongoClient(connectionString!);
    const currentCollection = "utenti";

    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(currentCollection);
        const result = await collection.updateOne({ "username": username }, { $set: { "info": infoAggiuntive } });
        if (result.matchedCount == 0) {
            res.status(404).json({ message: "Utente non trovato" });
        } else {
            res.status(200).json({ message: "Informazioni utente aggiornate con successo" });
        }
    } catch (err) {
        res.status(500).json({ message: "Errore esecuzione query: " + err });
    } finally {
        await client.close();
    }
});

//F.  Default root e gestione degli errori
app.use("/", function (req, res, next) {
    if (req.originalUrl.startsWith("/api/")) {
        // servizio non trovato
        res.status(404).send("Risorsa non trovata");
    }
    else
        res.sendStatus(404);
});

//G.  Gestione degli errori
app.use("/", function (err: Error, req: express.Request, res: express.Response, next: express.NextFunction) {
    res.status(500).send(err.message)
    console.log("******** ERRORE ********: \n" + err.stack);
});

function createToken(data: any) {
    const now = Math.floor(((new Date()).getTime() / 1000));
    const payload = {
        "_id": data._id,
        "username": data.username,
        "iat": data.iat || now,
        "exp": now + parseInt(process.env.DURATA_TOKEN!)
    }
    const token = jwt.sign(payload, jwtKey!);
    console.log("Creato nuovo TOKEN", token);
    return token;
}

async function sendGmail(email: string, passwordInChiaro: string): Promise<void> {
    try {
        const username = email.trim();
        let message = fs.readFileSync("./message.html", "utf8");
        message = message.replace("__user", username);
        message = message.replace("__password", passwordInChiaro);

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Costruzione del messaggio in formato MIME standard
        const rawMessage = [
            `From: ${process.env.GMAIL_USER}`,
            `To: ${username}`,
            `Subject: Nuovo account Rilievi e Perizie`,
            `MIME-Version: 1.0`,
            `Content-Type: text/html; charset=utf-8`,
            ``,
            message
        ].join('\n');

        // Codifica in Base64 URL-Safe richiesta dalle API di Google
        const encodedMessage = Buffer.from(rawMessage)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        const res = await gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw: encodedMessage }
        });

        console.log('EMAIL SENT (Gmail API):', res.data.id);
    } catch (err) {
        console.error("EMAIL ERROR (Gmail API):", err);
        // Lanciamo l'errore se vogliamo che il blocco catch della rotta lo intercetti
        throw err;
    }
}