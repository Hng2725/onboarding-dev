/// <reference types="vite/client" />

declare global {
  interface Window {
    __privosUiBooted?: boolean;
  }
}

export {};
