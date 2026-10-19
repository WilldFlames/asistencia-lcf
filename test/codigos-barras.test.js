const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');

test('códigos de barras conserva únicamente la impresión general en hoja carta',()=>{
  assert.match(html,/hoja imprimible con códigos Code128/i);
  assert.match(html,/@page \{ size: letter; margin: 1cm; \}/);
  assert.match(html,/grid-template-columns: repeat\(3, 5cm\)/);
  assert.match(html,/Imprimir hoja carta/);
  assert.match(html,/function construirHTMLBarras\(estudiantes, incluirScript = true\)/);
});

test('la previsualización general mantiene sus estilos aislados',()=>{
  assert.match(html,/class="cbar-carta-document"/);
  assert.match(html,/\.cbar-carta-document \.cbar-grid/);
  assert.doesNotMatch(html,/body \{ font-family: Arial, sans-serif; margin: 0; padding: 0; color: #000; \}/);
});
