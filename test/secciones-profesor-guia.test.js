const test = require('node:test');
const assert = require('node:assert/strict');

test('seccionesPermitidas reúne materias y sección guía sin confundir los dos roles', async () => {
  const db={
    async query(sql){
      if(sql.includes('FROM anios_lectivos')) return {rows:[{anio:2026}]};
      assert.match(sql,/FROM asignaciones a/);
      assert.match(sql,/FROM seccion_guia sg/);
      assert.match(sql,/FROM seccion_orientador so/);
      return {rows:[{seccion_id:4},{seccion_id:8},{seccion_id:8}]};
    }
  };
  const {seccionesPermitidas}=require('../utils/acceso-estudiantes');
  const ids=await seccionesPermitidas({id:17,rol:'profesor',funciones_extra:['profesor_guia']},db);
  assert.deepEqual(ids,[4,8]);
});

test('una función docente adicional también habilita las secciones', async () => {
  const db={
    async query(sql){
      if(sql.includes('FROM anios_lectivos')) return {rows:[{anio:2026}]};
      return {rows:[{seccion_id:3}]};
    }
  };
  const {seccionesPermitidas}=require('../utils/acceso-estudiantes');
  const ids=await seccionesPermitidas({id:21,rol:'coordinador',funciones_extra:['profesor_guia']},db);
  assert.deepEqual(ids,[3]);
});
