/**
 * SAT Catalog Data for CFDI 4.0 Mexican Electronic Invoicing
 *
 * Reference: Anexo 20 del SAT
 * http://omawww.sat.gob.mx/tramitesyservicios/Paginas/anexo_20.htm
 */

// c_RegimenFiscal - Tax Regime catalog
export const taxRegimes = [
  { code: '601', name: 'General de Ley Personas Morales' },
  { code: '603', name: 'Personas Morales con Fines no Lucrativos' },
  { code: '605', name: 'Sueldos y Salarios e Ingresos Asimilados a Salarios' },
  { code: '606', name: 'Arrendamiento' },
  { code: '608', name: 'Demas ingresos' },
  { code: '610', name: 'Residentes en el Extranjero sin Establecimiento Permanente en Mexico' },
  { code: '611', name: 'Ingresos por Dividendos (socios y accionistas)' },
  { code: '612', name: 'Personas Fisicas con Actividades Empresariales y Profesionales' },
  { code: '614', name: 'Ingresos por intereses' },
  { code: '616', name: 'Sin obligaciones fiscales' },
  { code: '620', name: 'Sociedades Cooperativas de Produccion que optan por diferir sus ingresos' },
  { code: '621', name: 'Incorporacion Fiscal' },
  { code: '622', name: 'Actividades Agricolas, Ganaderas, Silvicolas y Pesqueras' },
  { code: '623', name: 'Opcional para Grupos de Sociedades' },
  { code: '624', name: 'Coordinados' },
  { code: '625', name: 'Regimen de las Actividades Empresariales con ingresos a traves de Plataformas Tecnologicas' },
  { code: '626', name: 'Regimen Simplificado de Confianza (RESICO)' },
];

// c_UsoCFDI - CFDI Usage catalog
export const usoCfdi = [
  { code: 'G01', name: 'Adquisicion de mercancias' },
  { code: 'G02', name: 'Devoluciones, descuentos o bonificaciones' },
  { code: 'G03', name: 'Gastos en general' },
  { code: 'I01', name: 'Construcciones' },
  { code: 'I02', name: 'Mobilario y equipo de oficina por inversiones' },
  { code: 'I03', name: 'Equipo de transporte' },
  { code: 'I04', name: 'Equipo de computo y accesorios' },
  { code: 'I05', name: 'Dados, troqueles, moldes, matrices y herramental' },
  { code: 'I06', name: 'Comunicaciones telefonicas' },
  { code: 'I07', name: 'Comunicaciones satelitales' },
  { code: 'I08', name: 'Otra maquinaria y equipo' },
  { code: 'D01', name: 'Honorarios medicos, dentales y gastos hospitalarios' },
  { code: 'D02', name: 'Gastos medicos por incapacidad o discapacidad' },
  { code: 'D03', name: 'Gastos funerales' },
  { code: 'D04', name: 'Donativos' },
  { code: 'D05', name: 'Intereses reales efectivamente pagados por creditos hipotecarios' },
  { code: 'D06', name: 'Aportaciones voluntarias al SAR' },
  { code: 'D07', name: 'Primas por seguros de gastos medicos' },
  { code: 'D08', name: 'Gastos de transportacion escolar obligatoria' },
  { code: 'D09', name: 'Depositos en cuentas para el ahorro, primas de pensiones' },
  { code: 'D10', name: 'Pagos por servicios educativos' },
  { code: 'S01', name: 'Sin efectos fiscales' },
  { code: 'CP01', name: 'Pagos' },
];

// c_FormaPago - Payment Method catalog
export const formaPago = [
  { code: '01', name: 'Efectivo' },
  { code: '02', name: 'Cheque nominativo' },
  { code: '03', name: 'Transferencia electronica de fondos' },
  { code: '04', name: 'Tarjeta de credito' },
  { code: '05', name: 'Monedero electronico' },
  { code: '06', name: 'Dinero electronico' },
  { code: '08', name: 'Vales de despensa' },
  { code: '12', name: 'Dacion en pago' },
  { code: '13', name: 'Pago por subrogacion' },
  { code: '14', name: 'Pago por consignacion' },
  { code: '15', name: 'Condonacion' },
  { code: '17', name: 'Compensacion' },
  { code: '23', name: 'Novacion' },
  { code: '24', name: 'Confusion' },
  { code: '25', name: 'Remision de deuda' },
  { code: '26', name: 'Prescripcion o caducidad' },
  { code: '27', name: 'A satisfaccion del acreedor' },
  { code: '28', name: 'Tarjeta de debito' },
  { code: '29', name: 'Tarjeta de servicios' },
  { code: '30', name: 'Aplicacion de anticipos' },
  { code: '31', name: 'Intermediario pagos' },
  { code: '99', name: 'Por definir' },
];

// Cancellation Motives catalog
export const cancellationMotives = [
  { code: '01', name: 'Comprobante emitido con errores con relacion' },
  { code: '02', name: 'Comprobante emitido con errores sin relacion' },
  { code: '03', name: 'No se llevo a cabo la operacion' },
  { code: '04', name: 'Operacion nominativa relacionada en una factura global' },
];
