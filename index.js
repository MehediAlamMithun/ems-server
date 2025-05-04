require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");

const app = express();

app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());

// MongoDB
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.g9xsrko.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
let db;

async function run() {
  try {
    await client.connect();
    db = client.db("ems-demo");
    await db.command({ ping: 1 });
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ DB connection error:", err);
  }
}
run().catch(console.dir);

// JWT
app.post("/jwt", (req, res) => {
  const user = req.body;
  const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.send({ token });
});

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send({ message: "Unauthorized" });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).send({ message: "Forbidden" });
    req.decoded = decoded;
    next();
  });
}

// Routes
app.get("/", (req, res) => {
  res.send("🚀 EMS Backend is running");
});

app.get("/users", async (req, res) => {
  const email = req.query.email;
  if (email) {
    const user = await db.collection("users").findOne({ email });
    return user
      ? res.status(200).json(user)
      : res.status(404).json({ message: "User not found" });
  }
  const allUsers = await db.collection("users").find().toArray();
  res.status(200).json(allUsers);
});

app.get("/users/admin/:email", verifyToken, async (req, res) => {
  const email = req.params.email;
  if (req.decoded.email !== email) {
    return res.status(403).send({ isAdmin: false });
  }
  const user = await db.collection("users").findOne({ email });
  res.send({ isAdmin: user?.role === "admin" });
});

app.post("/users", async (req, res) => {
  const userData = req.body;
  if (!userData?.email) {
    return res.status(400).json({ message: "Email is required" });
  }

  const existingUser = await db
    .collection("users")
    .findOne({ email: userData.email });
  if (existingUser) {
    return res.status(409).json({ message: "User already exists" });
  }

  const prefix = "2025";
  const count = await db.collection("users").countDocuments();
  userData.employeeId = prefix + (count + 1).toString().padStart(4, "0");

  const result = await db.collection("users").insertOne(userData);
  res.status(201).json({
    message: "User created",
    insertedId: result.insertedId,
    employeeId: userData.employeeId,
  });
});

// Attendance + Performance Handling
app.patch("/users/:id", async (req, res) => {
  const { id } = req.params;
  const {
    action,
    date,
    weekDay,
    clockIn,
    clockOut,
    payroll,
    communicationRating,
    role,
  } = req.body;

  const userCollection = db.collection("users");
  const user = await userCollection.findOne({ _id: new ObjectId(id) });
  if (!user) return res.status(404).json({ message: "User not found" });

  if (action === "clockIn") {
    const exists = user.attendance?.some((entry) => entry.date === date);
    if (exists)
      return res.status(409).json({ message: "Already clocked in today." });

    await userCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $push: {
          attendance: {
            weekDay,
            date,
            clockIn,
            clockOut: "",
            payroll: "",
            communicationRating: 0,
          },
        },
      }
    );
    return res.status(200).json({ message: "Clock-in recorded." });
  }

  if (action === "clockOut") {
    await userCollection.updateOne(
      { _id: new ObjectId(id), "attendance.date": date },
      { $set: { "attendance.$.clockOut": clockOut } }
    );
    return res.status(200).json({ message: "Clock-out recorded." });
  }

  if (action === "updatePayroll") {
    const result = await userCollection.updateOne(
      { _id: new ObjectId(id), "attendance.date": date },
      { $set: { "attendance.$.payroll": payroll } }
    );

    // If date doesn't exist, add it as a new attendance record
    if (result.matchedCount === 0) {
      await userCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $push: {
            attendance: {
              weekDay: "",
              date,
              clockIn: "",
              clockOut: "",
              payroll,
              communicationRating: 0,
            },
          },
        }
      );
      return res.status(201).json({ message: "Payroll added to new entry." });
    }

    return res.status(200).json({ message: "Payroll updated successfully." });
  }

  if (action === "updateCommunication") {
    const result = await userCollection.updateOne(
      { _id: new ObjectId(id), "attendance.date": date },
      { $set: { "attendance.$.communicationRating": communicationRating } }
    );
    if (result.matchedCount === 0) {
      await userCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $push: {
            attendance: {
              weekDay: "",
              date,
              clockIn: "",
              clockOut: "",
              payroll: "",
              communicationRating,
            },
          },
        }
      );
      return res
        .status(201)
        .json({ message: "Communication added to new entry." });
    }
    return res.status(200).json({ message: "Communication updated" });
  }

  if (action === "updateRole") {
    if (!role) return res.status(400).json({ message: "Role is required" });

    const result = await userCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role } }
    );
    return result.modifiedCount === 0
      ? res.status(404).json({ message: "Failed to update role" })
      : res.status(200).json({ message: "Role updated" });
  }

  res.status(400).json({ message: "Invalid action" });
});

// Performance add/update
app.patch("/users/:id/performance", async (req, res) => {
  const { id } = req.params;
  const { date, score } = req.body;
  if (!date || typeof score !== "number") {
    return res.status(400).json({ message: "Date and numeric score required" });
  }

  const userCollection = db.collection("users");
  const user = await userCollection.findOne({ _id: new ObjectId(id) });
  if (!user) return res.status(404).json({ message: "User not found" });

  const exists = user.performance?.find((p) => p.date === date);
  if (exists) {
    await userCollection.updateOne(
      { _id: new ObjectId(id), "performance.date": date },
      { $set: { "performance.$.score": score } }
    );
    return res.status(200).json({ message: "Performance updated" });
  }

  await userCollection.updateOne(
    { _id: new ObjectId(id) },
    { $push: { performance: { date, score } } }
  );
  res.status(201).json({ message: "Performance added" });
});

// Reset endpoints
app.patch("/users/:id/communication/reset", async (req, res) => {
  const { id } = req.params;
  const { date } = req.body;
  await db
    .collection("users")
    .updateOne(
      { _id: new ObjectId(id), "attendance.date": date },
      { $set: { "attendance.$.communicationRating": 0 } }
    );
  res.send({ message: "Communication reset" });
});

app.patch("/users/:id/payroll/reset", async (req, res) => {
  const { id } = req.params;
  const { date } = req.body;
  await db
    .collection("users")
    .updateOne(
      { _id: new ObjectId(id), "attendance.date": date },
      { $set: { "attendance.$.payroll": "" } }
    );
  res.send({ message: "Payroll reset" });
});

app.patch("/users/:id/performance/reset", async (req, res) => {
  const { id } = req.params;
  const { date } = req.body;
  await db
    .collection("users")
    .updateOne({ _id: new ObjectId(id) }, { $pull: { performance: { date } } });
  res.send({ message: "Performance reset" });
});

app.patch("/users/:id/attendance/delete", async (req, res) => {
  const { id } = req.params;
  const { date } = req.body;
  await db
    .collection("users")
    .updateOne(
      { _id: new ObjectId(id) },
      { $pull: { attendance: { date }, performance: { date } } }
    );
  res.send({ message: "Attendance & performance deleted" });
});

// Express route - Add in your backend route file
app.get("/feedback", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ message: "Email required" });

  const user = await db.collection("users").findOne({ email });
  if (!user) return res.status(404).json({ message: "User not found" });

  const dailyFeedback =
    user.attendance?.map((day) => ({
      date: day.date,
      clockIn: day.clockIn || "Not Recorded",
      clockOut: day.clockOut || "Not Recorded",
      communicationRating: day.communicationRating || 0,
      payroll: day.payroll || "N/A",
    })) || [];

  res.json({ dailyFeedback });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🔉 Server running on port ${PORT}`));
