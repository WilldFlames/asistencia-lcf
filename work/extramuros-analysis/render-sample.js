const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const ui=fs.readFileSync(path.join(__dirname,'..','..','public','extramuros.js'),'utf8');
const context={
  console,
  htmlSeguro:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  nombrePersona:(p,o={})=>[p?.nombre,p?.primer_apellido,p?.segundo_apellido].filter(Boolean).join(' ')||o.vacio||'—',
  nombreEstudianteLista:p=>[p?.primer_apellido,p?.segundo_apellido].filter(Boolean).join(' ')+', '+(p?.nombre||''),
  nombreDesdeCampos:(n,a,b,o={})=>[n,a,b].filter(Boolean).join(' ')||o.vacio||'—',
  window:{},document:{},setTimeout,clearTimeout
};
vm.createContext(context);vm.runInContext(ui,context);
const detalle={actividad:{anio:2027,nombre_actividad:'Presentación de la Banda Estudiantil en el Festival Regional',objeto_actividad:'Representar al Liceo de Calle Fallas y fortalecer la convivencia, la identidad institucional y las habilidades artísticas del estudiantado.',mediacion_pedagogica:'Participación en ensayos guiados, presentación musical, intercambio con otras agrupaciones estudiantiles y reflexión posterior sobre el trabajo colaborativo.',lugar_actividad:'Parque La Libertad, Desamparados',fecha_actividad:'2027-05-18',hora_salida:'07:00',hora_regreso:'15:30',observaciones:'El estudiantado debe presentarse con uniforme completo, instrumento, hidratación y alimentación.',descripcion_exoneracion:'la participación en el Festival Regional de Bandas Estudiantiles'},responsables:[{nombre:'María',primer_apellido:'Rodríguez',segundo_apellido:'Solano',rol:'profesor'},{nombre:'Carlos',primer_apellido:'Mora',segundo_apellido:'Jiménez',rol:'profesor'}],config:{director_nombre:'Laura Cruz Campos'}};
const estudiante={consecutivo:1,nombre:'Daniel',primer_apellido:'Alvarado',segundo_apellido:'Fernández',cedula:'120860461',seccion_nombre:'10-1',nivel:10,enfermedad:'Asma leve',medicamento:'Inhalador de salbutamol según indicación médica',telefonos_emergencia:'8888-0000',encargado_nombre:'Ana',encargado_ap1:'Fernández',encargado_ap2:'Rojas',encargado_cedula:'107770777',encargado_parentesco:'madre',encargado_telefono:'2250-0000',encargado_celular:'8888-1111',encargado_email:'familia@example.com'};
const pages=[context.extPaginaAnexo1(detalle,estudiante),context.extPaginaAnexo2(detalle,estudiante),context.extPaginaAnexo3(detalle,estudiante)];
const header='<div class="official"><b>Ministerio de Educación Pública</b><span>Dirección Regional Desamparados · Circuito 07 · Liceo de Calle Fallas</span></div>';
const footer='<div class="footer">San José, Desamparados · Tel. 2250-0590 / 2250-0614 · lic.callefallas@mep.go.cr</div>';
const html=`<!doctype html><meta charset="utf-8"><style>@page{size:letter;margin:0}*{box-sizing:border-box}body{margin:0;background:#ddd}.sheet{width:8.5in;height:11in;background:white;margin:12px auto;padding:.32in .58in .52in;position:relative;overflow:hidden;page-break-after:always}.official{height:.72in;border-bottom:2px solid #1f3864;color:#1f3864;font:12px Arial;display:flex;flex-direction:column;justify-content:center}.official b{font-size:14px}.official span{margin-top:4px}.content{height:8.95in;padding-top:.08in}.footer{position:absolute;left:.4in;right:.4in;bottom:.22in;background:#1f3864;color:white;padding:7px;text-align:center;font:9px Arial}</style>${pages.map(p=>`<section class="sheet">${header}<main class="content">${p}</main>${footer}</section>`).join('')}`;
fs.writeFileSync(path.join(__dirname,'sample.html'),html);
