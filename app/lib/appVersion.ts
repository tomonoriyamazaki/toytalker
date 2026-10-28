import Constants from "expo-constants";

// アプリの版（app.json の expo.version）。Lambdaへの要求に app_version として添え、
// 切り分けログで「どの版のアプリからの要求か」を追えるようにする（docs/roadmap.md の9）。
export const APP_VERSION: string = Constants.expoConfig?.version ?? "unknown";
