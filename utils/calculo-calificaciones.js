function aporteEvaluacion(puntosObtenidos,puntajeTotal,valorPorcentual){
  const puntos=Number(puntosObtenidos);
  const total=Number(puntajeTotal);
  const valor=Number(valorPorcentual);
  if(!Number.isFinite(puntos)||!Number.isFinite(total)||!Number.isFinite(valor)||total<=0||valor<=0) return 0;
  return (puntos/total)*valor;
}

function valorVirtualPrueba({pesoRubro,cantidadPruebas,valoresExistentes}){
  const valores=(valoresExistentes||[]).map(Number);
  const conValor=valores.filter(v=>Number.isFinite(v)&&v>0);
  const sinValor=valores.length-conValor.length;
  if(!sinValor) return 0;
  const restante=Math.max(0,Number(pesoRubro||0)-conValor.reduce((s,v)=>s+v,0));
  const cantidadOficial=Math.max(0,Number(cantidadPruebas||0));
  const cupos=Math.max(sinValor,cantidadOficial-conValor.length,1);
  return restante/cupos;
}

module.exports={aporteEvaluacion,valorVirtualPrueba};
