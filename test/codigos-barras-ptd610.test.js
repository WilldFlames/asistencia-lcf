const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');

test('códigos de barras conserva hoja carta y agrega perfil Brother PT-D610BT',()=>{
  assert.match(html,/id="cbar-formato"/);
  assert.match(html,/value="carta">Hoja carta/);
  assert.match(html,/value="ptd610" selected>Brother P-touch PT-D610BT/);
  assert.match(html,/function construirHTMLBarrasPTD610/);
  assert.match(html,/@page \{ size: \$\{largo\}mm 24mm; margin: 0; \}/);
  assert.match(html,/height: 24mm/);
});

test('el perfil usa el área imprimible de 18 mm y una etiqueta por corte',()=>{
  assert.match(html,/padding: 3mm 3mm/);
  assert.match(html,/break-after: page; page-break-after: always/);
  assert.match(html,/cbar-cell:last-child \{ break-after: auto; page-break-after: auto; \}/);
  assert.match(html,/60 mm/);
  assert.match(html,/70 mm \(recomendado\)/);
  assert.match(html,/80 mm/);
});

test('la previsualización aísla sus estilos y no encoge la aplicación',()=>{
  assert.match(html,/class="cbar-ptouch-document"/);
  assert.match(html,/\.cbar-ptouch-document \.cbar-grid/);
  assert.doesNotMatch(html,/html, body \{\s*width: \$\{largo\}mm/);
  assert.doesNotMatch(html,/@media screen \{\s*body \{ background:#e5e7eb; \}/);
  assert.match(html,/<style>html,body\{margin:0;padding:0;background:#fff;\}<\/style><\/head>/);
});

test('la interfaz explica conexiones de computadora y móvil',()=>{
  assert.match(html,/escala 100 % y márgenes “ninguno”/);
  assert.match(html,/Brother iPrint&amp;Label/);
  assert.match(html,/Imprimir en PT-D610BT/);
});
