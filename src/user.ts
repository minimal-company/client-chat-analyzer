import { AuthError, addUser, listUsers, normalizeUsername, removeUser, resetUserPassword } from "./auth.js";

// Usuarios de la interfaz web (también se administran en el Panel de control › Usuarios):
//   cca user list
//   cca user add <usuario> ["Nombre"] [--admin]   contraseña temporal; rol analista salvo --admin
//   cca user reset <usuario>                      nueva contraseña temporal y cierra sus sesiones
//   cca user remove <usuario>                     lo borra y cierra sus sesiones
// La contraseña temporal se muestra una sola vez; al ingresar, la interfaz obliga a cambiarla.

const args = process.argv.slice(2);
const admin = args.includes("--admin");
const [command, rawName, displayName] = args.filter((a) => a !== "--admin");
const username = normalizeUsername(rawName);

try {
  switch (command) {
    case "list": {
      const users = await listUsers();
      if (!users.length) console.log("(sin usuarios)");
      for (const u of users) {
        const since = new Date(u.createdAt).toLocaleDateString("es-CO", { timeZone: "America/Bogota" });
        console.log(`${u.username.padEnd(28)} ${u.name.padEnd(24)} ${u.role.padEnd(9)} creado ${since}${u.mustChangePassword ? "  · debe cambiar la contraseña" : ""}`);
      }
      break;
    }
    case "add": {
      const password = await addUser(username, displayName, admin ? "admin" : "analista");
      console.log(`Usuario "${username}" creado (${admin ? "administrador" : "analista"}).\nContraseña temporal: ${password}\n(Se pide cambiarla al ingresar.)`);
      break;
    }
    case "reset": {
      const password = await resetUserPassword(username);
      console.log(`Nueva contraseña temporal para "${username}": ${password}\nSus sesiones abiertas se cerraron.`);
      break;
    }
    case "remove": {
      await removeUser(username);
      console.log(`Usuario "${username}" borrado; sus sesiones ya no valen.`);
      break;
    }
    default:
      throw new AuthError(400, 'Uso: cca user list | add <usuario> ["Nombre"] [--admin] | reset <usuario> | remove <usuario>');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
