// Compatibility module manager for the streamlined 1.4.10 UI.
// It intentionally never imports the legacy rules manager, rule editor,
// config wizard or validation-functions modules.
export class UIModuleManager {
  static isInitialized = false;
  static initializationError = null;

  static async initialize() {
    if (this.isInitialized) return true;
    try {
      const { UIStateManager } = await import('./ui-state-manager.js');
      await UIStateManager.initialize();
      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error('UI模块初始化失败:', error);
      this.initializationError = error;
      return false;
    }
  }

  static async finalizeInitialization() {
    return;
  }

  static getInitializationStatus() {
    return {
      isInitialized: this.isInitialized,
      error: this.initializationError,
      timestamp: new Date().toISOString(),
      modules: ['UIState'],
    };
  }

  static reset() {
    this.isInitialized = false;
    this.initializationError = null;
  }
}

if (typeof window !== 'undefined') {
  window.ResponseLinterUIModuleManager = UIModuleManager;
}
