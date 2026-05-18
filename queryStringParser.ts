/* NON È CONSENTITO MODIFICARE REQ["QUERY"] CHE È IN SOLA LETTURA
   NON È POSSIBILE NEANCHE MODIFICARE SINGOLARMENTE IL CONTENUTO DELLE SUE CHIAVI!*/
function parseQueryString(req: any, res: any, next: any) {
    req["parsedQuery"] = {};
    if (typeof req["query"] == "object" && req["query"]) {
        for (const key in req["query"]) {
            const value = req["query"][key];
            req["parsedQuery"][key] = parseValue(value);
        }
    }
    next();
}


function parseValue(value: any) {
    if (value == "true")
        return true;

    if (value == "false")
        return false;

    // simile a parseFloat() però cambia che
    // nel caso in cui la stringa contenga tipo "15a" parse int si ferma al primo carattere non numerico (15)
    // mentre number restituisce "NaN";
    // Number accetta sia interi che decimali 
    const num = Number(value);
    if (!isNaN(num)) // se è un numero valido
        return num;

    // NaN è un numero ma non è un numero valido
    // quindi nel caso di typeof NaN restituisce number 
    // e questo controllo non funziona 
    // if (typeof num == "number")
    //     return num;


    if (typeof value == "string" && (value.startsWith("{") || value.startsWith("["))) {
        try {
            return JSON.parse(value);
        }
        catch (error) {
            return value;
        }
    }

    //se è una stringa la lasciamo così come è
    return value;
}

export default parseQueryString;