# 📚 Study Portal

A modern **collaborative study platform** where students can join study rooms, interact in real-time, and solve doubts together using chat, video calls, and screen sharing.

## AIML Project Feature

This project now includes a **Student Performance Prediction and Study Recommendation System**. It uses a supervised **K-Nearest Neighbors (KNN)** classifier trained on 24 labelled student-learning samples. The model considers weekly study hours, attendance, previous score, assignment score, and sleep hours to predict one of four performance groups: **At Risk**, **Needs Improvement**, **On Track**, or **High Performer**.

After logging in, select **ML Predictor** on the dashboard to use the model. The ML logic is implemented in `ml/studentPerformanceModel.js` and is served through the authenticated `POST /api/ml/predict-performance` API.

---

## 🚀 Features

* 🔐 **Secure Authentication**

  * Login & Signup
  * OTP-based email verification
  * Password + Passkey support

* 🧑‍🤝‍🧑 **Study Rooms**

  * Join rooms instantly
  * Subject-based rooms (e.g., Calculus, Java)
  * One-click entry system

* 💬 **Real-Time Communication**

  * Chat with other students
  * Live doubt solving

* 🎥 **Video Conferencing**

  * Mic & camera support
  * Group discussion environment

* 🖥️ **Screen Sharing**

  * Share screen to explain concepts
  * Ideal for coding & problem solving

* 🎯 **Dashboard**

  * Personalized greeting
  * Active room overview
  * Focus mode

* 👤 **User Profile**

  * Update profile photo
  * Add personal bio

* 🔒 **Security Features**

  * JWT Authentication
  * Passkey login (biometric support)
  * Secure session handling

---

## 🛠️ Tech Stack

### Frontend

* React.js
* HTML, CSS, JavaScript

### Backend

* Node.js
* Express.js

### Database

* MongoDB

### Other Tools

* Git & GitHub
* REST APIs
* WebRTC (for video & screen sharing)

---

## 🌐 Deployment

* Backend hosted on **Render**
* Frontend deployed using **static hosting**

---

## 📂 Project Structure

```
StudyPortal/
│── public/
│── Models/
│── server.js
│── package.json
│── .env
```

---

## ⚙️ Installation & Setup

### 1️⃣ Clone the repository

```bash
git clone https://github.com/your-username/study-portal.git
cd study-portal
```

### 2️⃣ Install dependencies

```bash
npm install
```

### 3️⃣ Setup environment variables

Create a `.env` file and add:

```
PORT=5000
MONGO_URI=your_mongodb_connection
JWT_SECRET=your_secret_key
EMAIL_USER=your_email
EMAIL_PASS=your_email_password
```

### 4️⃣ Run the project

```bash
npm start
```

---

## 📡 API Usage

* JSON is used for data exchange between frontend and backend
* Example:

```json
{
  "email": "user@gmail.com",
  "password": "123456"
}
```

---

## 💡 Future Enhancements

* AI-based doubt solving
* Notes sharing system
* Attendance tracking
* Mobile app support

---

## 👨‍💻 Author

**Ayush Singh**
BTech CSE Student

---

## 📌 Conclusion

This project demonstrates a **full-stack MERN application** with real-time communication, secure authentication, and collaborative learning features.

---
