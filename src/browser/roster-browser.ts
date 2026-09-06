// One cached browser entry for the shared agent shells. Each client activates
// only when its own boot node is present, so pages do not create extra sockets.
import "./roster-client.js";
import "./monitor-client.js";
