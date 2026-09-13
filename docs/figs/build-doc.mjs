// Builds "Blackout - Estructura del software.docx".
// Run:  npm i docx && node build-doc.mjs .        (from this folder)
// The pngs next to it come from charts.html, rendered headless:
//   chrome --headless --force-device-scale-factor=3 --hide-scrollbars \
//     --screenshot=fig1.png --window-size=1090,480 "file://$PWD/charts.html?fig=1"
//   ...fig2 1090,570   fig3 1090,560
// The numbers in charts.html come from stats.mjs (run it at the repo root).
// Snippets are SLICED OUT OF THE REAL FILES by line range, never retyped: the
// document goes stale the day the code moves, and a re-run is the fix.
import fs from "fs";
import path from "path";
import {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, BorderStyle, AlignmentType, HeadingLevel, PageBreak, ShadingType,
} from "docx";

const REPO = "/Users/jesus/Documents/WRO 2026/Blackout-Explorations";
const OUT = path.join(REPO, "docs", "Blackout - Estructura del software.docx");
const FIG = process.argv[2] || ".";

const INK = "1E1D17", DIM = "7C776C", GREEN = "4A6752", BROWN = "8A5A10", RULE = "C9C4B8";
const MONO = "Consolas", SANS = "Calibri", SERIF = "Cambria";

// pull lines a..b (1-based, inclusive) out of a real source file
const slice = (rel, a, b) =>
  fs.readFileSync(path.join(REPO, rel), "utf8").split("\n").slice(a - 1, b).join("\n");

const p = (text, o = {}) => new Paragraph({
  spacing: { after: o.after ?? 120, line: 300 },
  alignment: o.align,
  children: [new TextRun({ text, font: o.font ?? SERIF, size: o.size ?? 21,
                           color: o.color ?? INK, bold: o.bold, italics: o.italics })],
});

const h1 = (n, text) => new Paragraph({
  spacing: { before: 360, after: 60 },
  children: [
    new TextRun({ text: `${n} · `, font: SANS, size: 26, bold: true, color: BROWN }),
    new TextRun({ text: text.toUpperCase(), font: SANS, size: 26, bold: true, color: INK,
                  characterSpacing: 20 }),
  ],
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 6 } },
});

const h2 = (text) => new Paragraph({
  spacing: { before: 240, after: 100 },
  children: [new TextRun({ text, font: SANS, size: 23, bold: true, color: INK })],
});

// one paragraph per source line, comment tail in green. The comment split is a
// plain indexOf: these snippets have no "//" inside a string, and a real lexer
// would be more code than the whole document.
const code = (text, lang = "js") => {
  const mark = lang === "py" ? "#" : "//";
  const lines = text.replace(/\t/g, "  ").split("\n");
  return lines.map((ln, i) => {
    const at = ln.indexOf(mark);
    const runs = at < 0
      ? [new TextRun({ text: ln || " ", font: MONO, size: 17, color: INK })]
      : [new TextRun({ text: ln.slice(0, at), font: MONO, size: 17, color: INK }),
         new TextRun({ text: ln.slice(at), font: MONO, size: 17, color: GREEN })];
    return new Paragraph({
      children: runs,
      spacing: { line: 240, before: i === 0 ? 60 : 0, after: i === lines.length - 1 ? 160 : 0 },
      shading: { type: ShadingType.CLEAR, fill: "F4F3EF" },
      indent: { left: 160, right: 160 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: RULE, space: 8 } },
    });
  });
};

const caption = (n, text) => new Paragraph({
  spacing: { before: 60, after: 260 },
  children: [
    new TextRun({ text: `Fig ${n}  `, font: SANS, size: 16, bold: true, color: BROWN }),
    new TextRun({ text, font: SANS, size: 16, color: DIM }),
  ],
});

const img = (file, wPx) => {
  const buf = fs.readFileSync(path.join(FIG, file));
  // the pngs are rendered at 3x; 1040 css px of drawing lands on a 6.5in text column
  const [w, h] = pngSize(buf);
  const width = wPx, height = Math.round(wPx * h / w);
  return new Paragraph({
    spacing: { before: 120, after: 0 },
    children: [new ImageRun({ data: buf, type: "png", transformation: { width, height } })],
  });
};
const pngSize = (b) => [b.readUInt32BE(16), b.readUInt32BE(20)];

const cell = (text, o = {}) => new TableCell({
  margins: { top: 60, bottom: 60, left: 100, right: 100 },
  shading: o.head ? { type: ShadingType.CLEAR, fill: "F0EFEA" } : undefined,
  borders: {
    top: { style: BorderStyle.SINGLE, size: 2, color: RULE },
    bottom: { style: BorderStyle.SINGLE, size: 2, color: RULE },
    left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
  },
  children: [new Paragraph({
    alignment: o.right ? AlignmentType.RIGHT : undefined,
    spacing: { after: 0 },
    children: [new TextRun({ text, font: o.mono ? MONO : SANS, size: o.head ? 16 : 17,
                             bold: o.head, color: o.dim ? DIM : INK })],
  })],
});

// widths are percentages; word wants twips, and a column list in the wrong unit
// collapses every column to one character wide.
const TEXT_DXA = 10040;
const table = (head, rows, pct) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  columnWidths: pct.map(x => Math.round(TEXT_DXA * x / 100)),
  rows: [
    new TableRow({ children: head.map((t, i) => cell(t, { head: true, right: i > 0 })) }),
    ...rows.map(r => new TableRow({
      children: r.map((t, i) => cell(String(t), { mono: i === 0, right: i > 0, dim: i === 2 })),
    })),
  ],
});

const TOP = [
  ["server/public/js/app.js", "4 310", "panel: telemetría, brazo, cintas, Sage"],
  ["server/public/css/style.css", "1 869", "hoja de estilo del panel"],
  ["docs/index.html", "1 659", "sitio público del equipo"],
  ["server/public/js/blkedit.js", "1 450", "editor táctil de BLK"],
  ["server/server.js", "1 367", "servidor: Sage, socket, historial"],
  ["CLAUDE.md", "1 355", "memoria de ingeniería del repositorio"],
  ["giga-r1/main/main.ino", "1 208", "firmware del vehículo"],
  ["OUTDATED/pca_test/servo.py", "1 114", "banco de brazo retirado"],
  ["server/public/js/i18n.js", "887", "cadenas es / en"],
  ["server/armrec.py", "835", "grabadora de tomas del brazo"],
];

const doc = new Document({
  styles: { default: { document: { run: { font: SERIF, size: 21, color: INK } } } },
  sections: [{
    properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
    children: [
      // ---- portada ----
      p("BLACKOUT · WRO 2026 FUTURE ENGINEERS", { font: SANS, size: 18, bold: true, color: BROWN, after: 40 }),
      p("ESTRUCTURA DEL REPOSITORIO", { font: SANS, size: 44, bold: true, after: 0 }),
      p("Y VOLUMEN DE CÓDIGO", { font: SANS, size: 44, bold: true, after: 160 }),
      p("Qué carpetas componen el proyecto, cuánto código propio hay en cada una y en qué lenguaje está escrito, con fragmentos comentados del código que sostiene el vehículo.",
        { size: 22, color: DIM, after: 240 }),
      table(["Recuento", "Valor"], [
        ["archivos versionados", "252", ""],
        ["líneas propias", "27 168", ""],
        ["lenguajes", "9", ""],
        ["pruebas automáticas", "28", ""],
        ["revisión", "09-09-2026", ""],
      ].map(r => [r[0], r[1]]), [70, 30]),

      // ---- 1 ----
      h1(1, "Estructura del repositorio"),
      p("El proyecto es un solo repositorio con tres firmwares y una estación de tierra. El vehículo sostiene por sí solo todo lo que debe seguir funcionando sin el ordenador —sensores, tracción, brazo, panel y la máquina virtual del lenguaje de misión—; el ordenador aporta lo que exige red, modelo o audio. Las cámaras tienen wifi y alimentación propios y no comparten enlace con el vehículo."),
      p("Cada carpeta de primer nivel corresponde a una de esas piezas, salvo OUTDATED/, que conserva el banco de pruebas retirado (Mega 2560 y Uno R3) porque los hallazgos de hardware siguen valiendo al portar código."),
      img("fig3.png", 624),
      caption(1, "Carpetas de primer nivel. Las líneas son código propio; el material vendorizado y los pesos del modelo de detección quedan fuera del recuento."),

      // ---- 2 ----
      h1(2, "Volumen por lenguaje"),
      p("El recuento sale de los archivos versionados en git (git ls-files), descartando lo que el equipo no escribió: bibliotecas vendorizadas, los 18 MB de pesos de coco-ssd, los archivos minificados y los package-lock. Quedan 112 archivos de código y documentación."),
      p("El reparto describe bien el sistema: más de la mitad es JavaScript, porque el panel, el agente Sage, el lenguaje BLK y las pruebas viven en el ordenador; el C++ del firmware es una décima parte del total y, aun así, es lo único que sigue funcionando cuando el enlace Bluetooth cae."),
      img("fig1.png", 624),
      caption(2, "Reparto de líneas por lenguaje. Markdown y JSON incluyen la memoria de ingeniería y las tomas grabadas del brazo, que son datos escritos por el equipo."),
      img("fig2.png", 624),
      caption(3, "Líneas por carpeta de primer nivel."),
      h2("Archivos más grandes"),
      table(["Archivo", "Líneas", "Qué contiene"], TOP.map(r => [r[0], r[1], r[2]]), [45, 12, 43]),

      new Paragraph({ children: [new PageBreak()] }),

      // ---- 3 ----
      h1(3, "Código comentado"),
      p("Seis fragmentos tomados tal cual del repositorio. Se eligieron porque cada uno resuelve un problema que costó una sesión de banco encontrar, y porque el comentario que llevan encima es la razón por la que no se vuelve a caer en él."),

      h2("3.1  El enlace Bluetooth se pierde por falta de sondeo, no por distancia"),
      p("ArduinoBLE sobre mbed atiende el transporte HCI en un segundo hilo que deja los paquetes recibidos en un buffer fijo; el hilo del sketch lo vacía llamando a BLE.poll(), y cuando se llena los paquetes se descartan, no se encolan. Una sola llamada por vuelta de loop() no basta: un fotograma del panel son ~23 ms de I2C, más que el intervalo de conexión. La solución es sondear desde dentro del bloqueo —aquí, al final de cada transferencia I2C del panel—, con lo que la ventana ciega baja de 23 ms a ~1,5 ms."),
      ...code(slice("giga-r1/main/main.ino", 116, 138), "cpp"),
      p("Regla que deja el hallazgo: cualquier cosa nueva que bloquee loop() más que un intervalo de conexión tiene que sondear. Y una llamada de biblioteca que bloquea es un punto ciego aunque el código de alrededor sondee, porque el sondeo está del lado de acá de la llamada.", { italics: true, color: DIM }),

      h2("3.2  Una mediana en anillo en lugar de tres pings seguidos"),
      p("El sonar se leía tres veces por envío con una espera entre lecturas para que el eco se apagara: ~200 ms muertos por vuelta, que eran a la vez la cadencia de telemetría y la latencia de las órdenes. Como los envíos ya están separados entre sí, la espera es gratis: se lanza un ping por envío y se toma la mediana de los últimos que hay en un anillo."),
      ...code(slice("giga-r1/main/main.ino", 1104, 1124), "cpp"),
      p("El anillo se siembra a -1 en setup(): una casilla inicializada a cero se lee como una pared a 0 cm y termina en el acto cualquier maniobra condicionada a la distancia.", { italics: true, color: DIM }),

      h2("3.3  Un servo de rotación continua no se queda quieto solo"),
      p("Las seis articulaciones del brazo son servos de 360°: no tienen realimentación de posición ni tope, y al soltar el pulso una articulación cargada cae por gravedad. Lo único que la sostiene es un pulso pequeño empujando hacia arriba, y la banda que la sostiene se mueve con la postura del brazo, porque el par de la gravedad también. Por eso el sesgo no es una constante sino una recta: un valor plano más una pendiente por cada segundo de recorrido desde el origen."),
      ...code(slice("giga-r1/main/arm.h", 156, 174), "cpp"),
      p("armTravel[] es la única estimación de postura que tiene este brazo (velocidad x tiempo desde el último origen), así que deriva; RE-HOME la pone a cero tras un atasco o un empujón.", { italics: true, color: DIM }),

      h2("3.4  Ninguna maniobra propuesta por la IA avanza a ciegas"),
      p("Sage puede proponer un programa corto en BLK, el lenguaje de misión del proyecto, y el operador decide si se ejecuta. Antes de que la tarjeta llegue a la pantalla, un avance sin condición se reescribe como el mismo impulso terminado en cuanto el sonar ve algo dentro de 10 cm. Una condición escrita por la propia Sage se respeta —un margen mayor es el objetivo, no un error— y los retrocesos y giros no se tocan, porque el sensor mira al frente y la comprobación saltaría contra la pared de la que se está alejando."),
      ...code(slice("server/public/js/blk.mjs", 484, 505)),
      p("El flujo del propio operador nunca se reescribe: el suyo vuelve como advertencia del linter en el panel de ejecución.", { italics: true, color: DIM }),

      h2("3.5  El vídeo se corta por longitud declarada, nunca buscando el separador"),
      p("El navegador no decodifica el MJPEG de las cámaras por sí solo de forma fiable: los bytes siguen llegando, la imagen se congela y no se dispara ningún evento. El panel lee el cuerpo de la respuesta y parte los fotogramas él mismo. La partición se hace por Content-Length porque el contenido JPEG puede contener por casualidad la misma secuencia de bytes que el separador."),
      ...code(slice("server/public/js/mjpeg.mjs", 1, 28)),
      p("Con los fotogramas en la mano, «congelado» pasa a ser una marca de tiempo, que es lo que vigila el temporizador de reconexión.", { italics: true, color: DIM }),

      h2("3.6  Un sensor que envía un cero no está leyendo"),
      p("La trama de telemetría rellena con ceros los campos de los sensores que aún no están montados, y un cero pintado como «normal» es una luz verde para hardware que no existe. Una sola función decide si un valor es una lectura: sólo tres sensores pueden leer cero de verdad —la distancia cuando no hay nada en rango, la altura cuando se está al nivel de la salida y la luz en una sala realmente a oscuras—."),
      ...code(slice("server/public/js/app.js", 64, 78)),
      p("La bandera se añade cuando el cero de ese sensor pasa a ser real, no cuando una casilla del panel se ve vacía.", { italics: true, color: DIM }),

      // ---- 4 ----
      h1(4, "Verificación"),
      p("El repositorio lleva 28 pruebas automáticas que se ejecutan sin vehículo: reproducen fuera del navegador la aritmética del brazo, el reparto de fotogramas, el compilador de BLK contra un espejo de la máquina virtual del firmware, el reproductor de cintas, la caja negra de la placa y el mando. Varias leen las constantes directamente del código del firmware y fallan si las dos mitades dejan de coincidir, que es la forma que tiene este proyecto de impedir que una misma cifra viva en dos sitios y se separe."),
      p("npm test · npm run test:arm · test:blk · test:tape · test:mjpeg · test:detect · test:sonar · test:blackbox · test:padnav · test:led …",
        { font: MONO, size: 17, color: DIM }),
    ],
  }],
});

const buf = await Packer.toBuffer(doc);
fs.writeFileSync(OUT, buf);
console.log("wrote", OUT, (buf.length / 1024).toFixed(0) + " KB");
