export const homepage = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pixel Health</title></head>
<body>
<main>
<h1>Pixel Health</h1>
<p>Pixel Health es un sistema privado de procesamiento de datos de salud personales para un único usuario.</p>
<a href="/privacy">Política de privacidad</a>
</main>
</body>
</html>`;

export const privacy = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Política de privacidad — Pixel Health</title></head>
<body>
<main>
<h1>Política de privacidad de Pixel Health</h1>
<p>Pixel Health tiene un único usuario personal: su propio desarrollador.</p>
<p>Lee los datos de Google Health de su propietario con permisos de solo lectura y los almacena en la cuenta de Cloudflare del propio propietario.</p>
<p>También almacena los eventos que registra el propietario: café, alcohol y tabaco.</p>
<p>Los datos solo salen hacia el asistente que conectes y autorices, cuando tú, como propietario, lo solicites.</p>
<p>Los datos nunca se venden, se comparten ni se utilizan para publicidad.</p>
<p>Puedes revocar el acceso en <a href="https://myaccount.google.com/permissions">los permisos de tu cuenta de Google</a>.</p>
<p>Contacto: <a href="mailto:deluispablo@gmail.com">deluispablo@gmail.com</a>.</p>
<a href="/">Pixel Health</a>
</main>
</body>
</html>`;

export function pageResponse(request: Request, html: string): Response {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
  }
  return new Response(request.method === "HEAD" ? null : html, { headers });
}
