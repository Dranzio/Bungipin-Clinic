CREATE DATABASE IF NOT EXISTS dental_appointments;
USE dental_appointments;

-- Drop Instances *
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS xrays;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS allergies;
DROP TABLE IF EXISTS prescriptions;
DROP TABLE IF EXISTS health_conditions;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS admin_profiles;
DROP TABLE IF EXISTS employee_profiles;
DROP TABLE IF EXISTS patient_profiles;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    user_id         INT AUTO_INCREMENT PRIMARY KEY,
    public_id       VARCHAR(10) UNIQUE,       
    first_name      VARCHAR(50)  NOT NULL,
    last_name       VARCHAR(50)  NOT NULL,
    email           VARCHAR(150) NOT NULL UNIQUE,
    phone           VARCHAR(20),
    password_hash   VARCHAR(255) NOT NULL,
    sex             VARCHAR(10),
    role            ENUM('patient','employee','admin') NOT NULL,
    account_status  ENUM('active','suspended') NOT NULL DEFAULT 'active',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Public ID Procedure
DELIMITER $$
CREATE PROCEDURE sp_register_user(
    IN p_first_name  VARCHAR(50),
    IN p_last_name   VARCHAR(50),
    IN p_email       VARCHAR(150),
    IN p_phone       VARCHAR(20),
    IN p_password_hash VARCHAR(255),
    IN p_sex         VARCHAR(10),
    IN p_role        ENUM('patient','employee','admin'),
    OUT p_new_user_id INT
)
BEGIN
    INSERT INTO users (first_name, last_name, email, phone, password_hash, sex, role)
    VALUES (p_first_name, p_last_name, p_email, p_phone, p_password_hash, p_sex, p_role);

    SET p_new_user_id = LAST_INSERT_ID();

    UPDATE users
    SET public_id = CONCAT(
        CASE p_role
            WHEN 'patient'  THEN 'PAT'
            WHEN 'employee' THEN 'EMP'
            WHEN 'admin'    THEN 'ADM'
            ELSE 'USR'
        END,
        '-', LPAD(p_new_user_id, 4, '0')
    )
    WHERE user_id = p_new_user_id;
END$$
DELIMITER ;

CREATE TABLE patient_profiles (
    patient_id       INT PRIMARY KEY,
    birthday         DATE,
    civil_status     VARCHAR(30),
    secondary_email  VARCHAR(150),
    address          VARCHAR(255),
    pregnancy_status VARCHAR(30),
    FOREIGN KEY (patient_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE employee_profiles (
    employee_id   INT PRIMARY KEY,
    staff_code    VARCHAR(30) UNIQUE,
    birthday      DATE,
    civil_status  VARCHAR(30),
    FOREIGN KEY (employee_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE admin_profiles (
    admin_id          INT PRIMARY KEY,
    permission_level  VARCHAR(30),
    FOREIGN KEY (admin_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE audit_logs (
    log_id        INT AUTO_INCREMENT PRIMARY KEY,
    admin_id      INT NOT NULL,
    action        VARCHAR(100) NOT NULL,
    target_table  VARCHAR(50)  NOT NULL,
    target_id     INT NOT NULL,
    notes         TEXT,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admin_profiles(admin_id) ON DELETE CASCADE
);

CREATE TABLE health_conditions (
    condition_id  INT AUTO_INCREMENT PRIMARY KEY,
    patient_id    INT NOT NULL,
    description   VARCHAR(255) NOT NULL,
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE prescriptions (
    prescription_id  INT AUTO_INCREMENT PRIMARY KEY,
    patient_id       INT NOT NULL,
    medication_name  VARCHAR(100) NOT NULL,
    dosage           VARCHAR(50),
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE allergies (
    allergy_id   INT AUTO_INCREMENT PRIMARY KEY,
    patient_id   INT NOT NULL,
    allergen     VARCHAR(100) NOT NULL,
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE services (
    service_id    INT AUTO_INCREMENT PRIMARY KEY,
    label         VARCHAR(100) NOT NULL,
    price         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    icon          VARCHAR(255),
    is_available  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE appointments (
    appointment_id      INT AUTO_INCREMENT PRIMARY KEY,
    patient_id          INT NOT NULL,
    employee_id         INT NULL,           -- assigned by staff after booking, not at booking time
    service_id          INT NOT NULL,
    appointment_date    DATE NOT NULL,
    time_slot           TIME NOT NULL,
    appointment_status  ENUM('pending','approved','completed','cancelled') NOT NULL DEFAULT 'pending',
    queue_status         ENUM('pending','waiting','in_chair','paid') NULL,
    patient_note         VARCHAR(255),
    dentist_note          VARCHAR(255),
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id)  REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id) REFERENCES employee_profiles(employee_id) ON DELETE SET NULL,
    FOREIGN KEY (service_id)  REFERENCES services(service_id) ON DELETE RESTRICT,
    
    UNIQUE KEY unique_employee_slot (employee_id, appointment_date, time_slot)
);

CREATE TABLE payments (
    payment_id       INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id   INT NOT NULL UNIQUE,
    amount           DECIMAL(10,2) NOT NULL,
    payment_date     DATE,
    method           ENUM('cash','card','online') NOT NULL,
    status           ENUM('pending','paid','refunded') NOT NULL DEFAULT 'pending',
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE CASCADE
);

CREATE TABLE xrays (
    xray_id         INT AUTO_INCREMENT PRIMARY KEY,
    patient_id      INT NOT NULL,
    appointment_id  INT NULL,
    uploaded_by     INT NOT NULL,
    file_url        VARCHAR(255) NOT NULL,
    uploaded_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id)     REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE SET NULL,
    FOREIGN KEY (uploaded_by)    REFERENCES employee_profiles(employee_id) ON DELETE RESTRICT
);

CREATE TABLE messages (
    message_id   INT AUTO_INCREMENT PRIMARY KEY,
    sender_id    INT NOT NULL,
    receiver_id  INT NOT NULL,
    content      TEXT,
    file_url     VARCHAR(255),
    sent_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_read      BOOLEAN NOT NULL DEFAULT FALSE,
    FOREIGN KEY (sender_id)   REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE notifications (
    notification_id  INT AUTO_INCREMENT PRIMARY KEY,
    user_id          INT NOT NULL,
    type             VARCHAR(50) NOT NULL,
    title            VARCHAR(100) NOT NULL,
    message          TEXT,
    appointment_id   INT NULL,
    message_id       INT NULL,
    is_read          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)        REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE CASCADE,
    FOREIGN KEY (message_id)     REFERENCES messages(message_id) ON DELETE CASCADE,
    -- ensures a notification references at most one source, never both
    CONSTRAINT chk_single_source CHECK (
        NOT (appointment_id IS NOT NULL AND message_id IS NOT NULL)
    )
);

-- Double Check
CALL sp_register_user('Maria', 'Santos', 'maria.santos@example.com', '09171234567', '<hashed_pw>', 'F', 'patient', @uid1);
CALL sp_register_user('Juan', 'Dela Cruz', 'juan.delacruz@example.com', '09179876543', '<hashed_pw>', 'M', 'patient', @uid2);
CALL sp_register_user('Ramon', 'Cruz', 'ramon.cruz@example.com', '09201112222', '<hashed_pw>', 'M', 'employee', @uid3);
CALL sp_register_user('Liza', 'Tan', 'liza.tan@example.com', '09203334444', '<hashed_pw>', 'F', 'employee', @uid4);
CALL sp_register_user('Carla', 'Reyes', 'carla.reyes@example.com', '09051119999', '<hashed_pw>', 'F', 'admin', @uid5);

select * from users;

INSERT INTO patient_profiles (patient_id, birthday, civil_status, address) VALUES
(1, '1990-04-12', 'Single', '123 Mabini St, Quezon City'),
(2, '1985-11-02', 'Married', '45 Rizal Ave, Manila');

INSERT INTO employee_profiles (employee_id, staff_code, birthday, civil_status) VALUES
(3, 'STF-2026-001', '1985-06-10', 'Married'),
(4, 'STF-2026-002', '1990-02-20', 'Single');

INSERT INTO admin_profiles (admin_id, permission_level) VALUES
(5, 'full_access');

INSERT INTO services (label, price, icon, is_available) VALUES
('Dental Cleaning', 800.00, 'cleaning-icon', TRUE),
('Tooth Extraction', 1500.00, 'extraction-icon', TRUE),
('Braces Consultation', 500.00, 'braces-icon', FALSE);

INSERT INTO appointments (patient_id, employee_id, service_id, appointment_date, time_slot, appointment_status, patient_note) VALUES
(1, 3, 1, '2026-09-10', '10:00:00', 'approved', 'First-time patient'),
(2, NULL, 2, '2026-09-12', '11:00:00', 'pending', NULL);

INSERT INTO payments (appointment_id, amount, payment_date, method, status) VALUES
(1, 800.00, '2026-09-10', 'card', 'paid');

INSERT INTO xrays (patient_id, appointment_id, uploaded_by, file_url) VALUES
(1, 1, 3, '/xrays/patient1_visit1.png');

INSERT INTO messages (sender_id, receiver_id, content, is_read) VALUES
(3, 1, 'Please arrive 10 minutes early for your cleaning.', FALSE);

INSERT INTO notifications (user_id, type, title, message, appointment_id) VALUES
(1, 'appointment_status', 'Appointment Approved', 'Your appointment on 2026-09-10 has been approved.', 1);

INSERT INTO notifications (user_id, type, title, message, message_id) VALUES
(1, 'new_message', 'New Message', 'You have a new message from Dr. Ramon Cruz.', 1);
