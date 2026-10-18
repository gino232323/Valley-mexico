# Servidor de salas privadas — Harvest Valley México (prototipo)

Este relay experimental permite crear una sala privada de hasta dos jugadores. Comparte el código y la semilla del mapa, y retransmite estados de posición/dirección y eventos de los botones A/B. **No es un servidor de juego autoritativo ni sincroniza los cambios del mundo.**

## Requisitos

- Node.js 18 o posterior.
- Una terminal en el equipo donde ejecutarás el servidor.

## Ejecutar en la misma computadora

1. Descomprime el paquete.
2. Abre una terminal en `hv-online-server/`.
3. Ejecuta `npm install` una vez.
4. Ejecuta `npm start` y deja la terminal abierta. Por defecto escucha en el puerto `8080`.
5. Abre `Harvest_Valley_Mexico_online_multijugador_beta.html` en dos ventanas/navegadores. En **Partida privada · beta**, deja `ws://localhost:8080`; una persona crea la sala y la otra escribe el código.
6. Si el navegador no permite conectar desde un archivo local, sirve el HTML desde un servidor web local y vuelve a probar.

Comprobación del servidor: abre `http://localhost:8080/health`; debe devolver JSON con `ok: true`.

## Jugar en una red local

Ejecuta el servidor en una computadora accesible por ambos jugadores y usa en el campo «Dirección del servidor» su dirección IP local, por ejemplo `ws://192.168.1.20:8080`. Permite el puerto TCP 8080 en el firewall solo para la red de confianza. La dirección `localhost` solo apunta al dispositivo que abre cada navegador, por lo que no sirve para conectar dos dispositivos distintos.

## Acceso por internet (no configurado)

El servidor debe desplegarse en un proveedor alcanzable desde internet y exponerse mediante **WSS** (WebSocket seguro), por ejemplo `wss://tu-dominio.example`. Si el juego se sirve por HTTPS, los navegadores normalmente bloquean `ws://` inseguro. Configura un proxy inverso TLS que reenvíe WebSocket al puerto interno `8080`, y restringe el acceso según las necesidades de tu despliegue. Este paquete **no incluye hosting, dominio, TLS, autenticación, moderación ni credenciales de proveedor**; no se ha publicado ni alojado el servidor.

## Alcance y advertencias

- Dos jugadores como máximo por sala; los códigos no sustituyen autenticación ni son una medida de seguridad para información sensible.
- Misma semilla/mapa y posiciones aproximadas del otro granjero; las acciones A/B se muestran como eventos visuales breves.
- No sincroniza cosechas y sus resultados, inventario, cultivos/crecimiento, animales, hora o clima del mundo ni otras mutaciones compartidas. Cada navegador sigue ejecutando su propia simulación y guardado local.
- Prototipo de desarrollo, no listo para producción. El despliegue público requiere configurar y operar un servidor WSS accesible.
