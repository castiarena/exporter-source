/**
 * Minimal type surface for the two vendored libraries. Both ship as plain JS in
 * vendor/, so these declarations describe only the API this extension uses —
 * anything else is a compile error rather than an `any`.
 */
declare module '*/vendor/html2canvas/html2canvas.esm.js' {
  export interface Html2CanvasOptions {
    scale?: number;
    useCORS?: boolean;
    allowTaint?: boolean;
    backgroundColor?: string | null;
    logging?: boolean;
    removeContainer?: boolean;
    scrollX?: number;
    scrollY?: number;
    windowWidth?: number;
    windowHeight?: number;
    width?: number;
    height?: number;
  }
  export default function html2canvas(
    element: HTMLElement,
    options?: Html2CanvasOptions,
  ): Promise<HTMLCanvasElement>;
}

declare module '*/vendor/jspdf/jspdf.es.min.js' {
  export interface JsPdfOptions {
    unit?: 'pt' | 'px' | 'in' | 'mm' | 'cm' | 'ex' | 'em' | 'pc';
    format?: string | [number, number];
    orientation?: 'portrait' | 'landscape' | 'p' | 'l';
    compress?: boolean;
  }
  export class jsPDF {
    constructor(options?: JsPdfOptions);
    addPage(format?: string | [number, number], orientation?: string): jsPDF;
    addImage(
      imageData: string | HTMLCanvasElement,
      format: string,
      x: number,
      y: number,
      width: number,
      height: number,
      alias?: string,
      compression?: 'NONE' | 'FAST' | 'MEDIUM' | 'SLOW',
    ): jsPDF;
    output(type: 'datauristring' | 'arraybuffer' | 'blob' | 'string'): unknown;
  }
  export default jsPDF;
}
